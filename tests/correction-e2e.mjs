// 端到端验证「老师更正板书」场景：真调一次模型，检查笔记里有没有留下作废的写法。
// 用法：node tests/correction-e2e.mjs
// 注意：会调用一次文本模型（需要 DeepSeek Key），约 1 分钟。
import fs from 'node:fs';
import path from 'node:path';
import { synthesize } from '../app/lib/fusion.mjs';
import { loadConfig } from '../app/lib/config.mjs';
import { findCorrections } from '../app/lib/corrections.mjs';

const cacheDir = path.join(process.cwd(), 'data', '_tmp-correction-e2e');
fs.rmSync(cacheDir, { recursive: true, force: true });
fs.mkdirSync(cacheDir, { recursive: true });

// 场景：老师先写了一个「只对单极点成立」的留数公式，当成通用公式；
// 10 分钟后发现不对，擦掉重写并口头更正。
const seg = (start, text) => ({ start, end: start + 5, text });

const transcript = {
  segments: [
    seg(30, '这节课我们讲留数的计算。'),
    seg(60, '留数的公式很简单，就是 Res 在 z0 处的留数等于 lim(z 趋于 z0) (z 减 z0) 乘以 f(z)。'),
    seg(120, '大家把这个公式记下来，以后算留数就直接套。'),
    seg(600, '等一下，我刚才那个公式写错了，那个只对单极点成立。'),
    seg(610, '本性奇点不能用这个极限公式，必须老老实实作洛朗展开，取负一次幂的系数 C 负一。'),
    seg(640, '所以更正一下：单极点用极限公式，本性奇点只能用洛朗展开。'),
    seg(700, '举个例子，e 的 1/z 次方在 z 等于 0 处就是本性奇点，只能展开。'),
  ],
};

const snapshots = [
  {
    t: 60,
    generation: 0,
    erased: true,
    imagePath: path.join(cacheDir, 'g0.png'),
    ocr: { title: '留数的计算', text: 'Res_{z=z0} f(z) = lim_{z→z0} (z - z0) f(z)\n（通用公式）' },
  },
  {
    t: 620,
    generation: 1,
    erased: false,
    imagePath: path.join(cacheDir, 'g1.png'),
    ocr: {
      title: '更正：单极点 vs 本性奇点',
      text: '单极点：Res_{z=z0} f(z) = lim_{z→z0} (z - z0) f(z)\n本性奇点：只能作洛朗展开，取 C_{-1}',
    },
  },
];

const cfg = loadConfig();
const corrections = findCorrections(transcript.segments);
console.log(`检测到 ${corrections.length} 处更正：`);
for (const c of corrections) console.log(`  · [${c.t}s] ${c.label}：「${c.text}」`);
if (!corrections.length) {
  console.log('✗ 没检测到更正，测试场景本身有问题');
  process.exit(1);
}

console.log('\n开始整理笔记（调用模型）…');
const t0 = Date.now();
const doc = await synthesize({
  transcript,
  snapshots,
  duration: 900,
  meta: { title: '留数的计算（更正测试）', course: '数学物理方法' },
  cfg,
  cacheDir,
  onEvent: (ev) => {
    if (ev.type === 'log') console.log('  ' + ev.message);
  },
  concurrency: 1,
  bustCache: true,
});
console.log(`用时 ${Math.round((Date.now() - t0) / 1000)} 秒`);

const body = doc.sections.map((s) => s.markdown).join('\n\n');
const full = [doc.overview, body, doc.formulas, doc.glossary].filter(Boolean).join('\n\n');

console.log('\n──────── 成稿正文 ────────');
console.log(body.slice(0, 1600));

// 判定：正文里必须出现「只对单极点成立」这类限定，且要标注更正。
// 注意：更正标注（引用块）里出现「原写法当作通用公式…已作废」是**正确的**，
// 所以先去掉引用块再检查，避免误判。
const prose = full
  .split('\n')
  .filter((l) => !/^\s*>/.test(l))
  .join('\n');

const checks = [
  ['正文提到这是单极点专用（不是通用公式）', /单极点/.test(full)],
  ['正文提到本性奇点要用洛朗展开', /洛朗|罗朗/.test(full)],
  ['正文标注了「更正」', /更正|订正|写错|作废/.test(full)],
  ['正文（更正标注之外）没有把作废写法当结论', !/通用公式|直接套用/.test(prose)],
  ['doc.corrections 已带进文档（供附录使用）', Array.isArray(doc.corrections) && doc.corrections.length > 0],
];

console.log('\n──────── 检查 ────────');
let bad = 0;
for (const [name, ok] of checks) {
  if (!ok) bad++;
  console.log(`${ok ? '✓' : '✗'} ${name}`);
}
console.log(bad ? `\n✗ ${bad} 项不通过` : '\n✓ 笔记正确采用了更正后的版本');
fs.rmSync(cacheDir, { recursive: true, force: true });
process.exit(bad ? 1 : 0);
