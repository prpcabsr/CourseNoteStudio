// 生成一段「合成的黑板课」测试视频，用来验证板书追踪逻辑：
// 三段板书（写满 → 擦掉 → 再写满 → 再擦掉 → 第三段），并带中文语音讲解。
// 用法：node tests/make-fixture.mjs [输出文件]
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { findFfmpeg } from '../app/lib/paths.mjs';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const out = process.argv[2] || path.join(ROOT, 'data', 'fixture', 'sample-lecture.mp4');
const work = path.join(ROOT, 'data', 'fixture');
fs.mkdirSync(work, { recursive: true });

const FONT = 'C\\:/Windows/Fonts/simhei.ttf';
const DUR = 140;

// 三段板书：每段内部逐行出现，段末整块擦除
const LINES = [
  // [出现时间, 消失时间, 文本, y]
  [2, 40, '第一章  极限与连续', 70],
  [10, 40, '定义 函数 f(x) 在 x0 处连续', 180],
  [20, 40, 'lim(x→x0) f(x) = f(x0)', 290],
  [28, 40, '例 证明 f(x)=x² 处处连续', 400],
  [33, 40, '证 |x²-x0²| = |x-x0||x+x0|', 500],

  [45, 92, '连续性判定三步', 70],
  [52, 92, '1  求极限 lim f(x)', 180],
  [60, 92, '2  求函数值 f(x0)', 290],
  [68, 92, '3  比较两者是否相等', 400],
  [76, 92, '结论 三者相等 则连续', 500],

  [96, 140, '课后作业', 70],
  [104, 140, 'P45 习题 3 5 7', 180],
  [114, 140, '预习 导数的定义', 290],
];

const NARRATION = [
  { file: 'n1.wav', at: 3, text: '这节课我们讲函数的连续性。先看定义，函数 f x 在 x 零处连续，意思是当 x 趋近于 x 零时，f x 的极限等于 f x 零。我们再用一个例子来说明，证明 f x 等于 x 平方处处连续，关键是把 x 平方减 x 零平方拆成两项相乘。' },
  { file: 'n2.wav', at: 46, text: '判断连续性一共三步。第一步，求极限；第二步，求函数值；第三步，比较两者是否相等。如果三者相等，函数在这个点就是连续的。做题的时候一定要注意先看定义域。' },
  { file: 'n3.wav', at: 97, text: '今天的课后作业是第四十五页，习题三、五、七。下次课我们预习导数的定义，请大家提前看一下课本。' },
];

function sh(cmd, args) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { windowsHide: true });
    let err = '';
    p.stderr.on('data', (d) => (err += d.toString()));
    p.on('close', (c) => (c === 0 ? resolve() : reject(new Error(`${cmd} 失败 ${c}: ${err.slice(0, 500)}`))));
    p.on('error', reject);
  });
}

// 1) 用 Windows 内置语音合成生成讲解音频
const tts = `
Add-Type -AssemblyName System.Speech
$s = New-Object System.Speech.Synthesis.SpeechSynthesizer
$s.SelectVoice('Microsoft Huihui Desktop')
$s.Rate = 0
${NARRATION.map((n) => `$s.SetOutputToWaveFile('${path.join(work, n.file)}')\n$s.Speak('${n.text}')\n$s.SetOutputToNull()`).join('\n')}
`;
await sh('powershell', ['-NoProfile', '-Command', tts]);
console.log('语音合成完成');

// 2) 组装 filtergraph
const chain = [];
LINES.forEach(([a, b, text, y], i) => {
  chain.push(
    `drawtext=fontfile='${FONT}':text='${text}':fontcolor=white@0.94:fontsize=52:x=70:y=${y}:enable='between(t,${a},${b})'`,
  );
});
// 板书边框，让它更像一块黑板
chain.unshift("drawbox=x=40:y=30:w=1200:h=660:color=0x3a5a45@1:t=4");

const filter = [
  `[0:v][4:v]overlay=x='40+560*abs(sin(t*0.45))':y=300:enable='lt(mod(t,23),7)'[base]`,
  `[base]${chain.join(',')}[v]`,
  `[1:a]adelay=${NARRATION[0].at * 1000}|${NARRATION[0].at * 1000}[a1]`,
  `[2:a]adelay=${NARRATION[1].at * 1000}|${NARRATION[1].at * 1000}[a2]`,
  `[3:a]adelay=${NARRATION[2].at * 1000}|${NARRATION[2].at * 1000}[a3]`,
  `[a1][a2][a3]amix=inputs=3:normalize=0,volume=2.2[a]`,
].join(';\n');

const filterFile = path.join(work, 'filter.txt');
fs.writeFileSync(filterFile, filter, 'utf8');

const ff = findFfmpeg();
await sh(ff, [
  '-y', '-hide_banner', '-loglevel', 'error',
  '-f', 'lavfi', '-i', `color=c=0x1d2b23:s=1280x720:r=10:d=${DUR}`,
  '-i', path.join(work, 'n1.wav'),
  '-i', path.join(work, 'n2.wav'),
  '-i', path.join(work, 'n3.wav'),
  '-f', 'lavfi', '-i', `color=c=0x33465a:s=150x400:r=10:d=${DUR}`,
  '-filter_complex_script', filterFile,
  '-map', '[v]', '-map', '[a]',
  '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '24', '-pix_fmt', 'yuv420p',
  '-c:a', 'aac', '-b:a', '96k', '-t', String(DUR),
  out,
]);
console.log('测试视频已生成：' + out);
console.log('内容：3 块板书（写满后被擦除 2 次）+ 中文讲解语音');
