// 端到端验证「整理成文 + 排版出 PDF」这两步（不依赖语音/视觉模型是否装好）。
// 用法：node tests/render-check.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { synthesize, fmtTime } from '../app/lib/fusion.mjs';
import { buildHtml, htmlToPdf, ensureKatexAssets, ASSET_DIR } from '../app/lib/render.mjs';
import { loadConfig } from '../app/lib/config.mjs';
import { probeVideo } from '../app/lib/detect.mjs';
import { grabFrame } from '../app/lib/proc.mjs';
import { probeMedia } from '../app/lib/ingest.mjs';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const video = path.join(ROOT, 'data', 'fixture', 'sample-lecture.mp4');
const outDir = path.join(ROOT, 'data', 'fixture', 'out');
const workDir = path.join(ROOT, 'data', 'fixture', 'work');
fs.mkdirSync(outDir, { recursive: true });
fs.mkdirSync(workDir, { recursive: true });

const info = await probeMedia(video);

// 1) 真实跑一遍板书追踪，拿到抓拍点与裁剪区域
const probe = await probeVideo({
  video, width: info.width, height: info.height, duration: info.duration,
  options: { density: 'balanced' }, onEvent: () => {},
});
console.log(`抓拍点 ${probe.points.length} 个，板书 ${probe.generations.length} 块`);

// 2) 抽出截图（模拟视觉识别结果：用人工写的板书原文代替模型输出）
const FAKE_TEXT = {
  13: '第一章  极限与连续\n定义 函数 f(x) 在 x0 处连续',
  36: '第一章  极限与连续\n定义 函数 f(x) 在 x0 处连续\nlim(x→x0) f(x) = f(x0)\n例 证明 f(x)=x^2 处处连续\n证 |x^2-x0^2| = |x-x0||x+x0|',
  56: '连续性判定三步\n1 求极限 lim f(x)\n2 求函数值 f(x0)',
  63: '连续性判定三步\n1 求极限 lim f(x)\n2 求函数值 f(x0)\n3 比较两者是否相等',
  79: '连续性判定三步\n1 求极限 lim f(x)\n2 求函数值 f(x0)\n3 比较两者是否相等\n结论 三者相等 则连续',
  102: '课后作业',
  125: '课后作业\nP45 习题 3 5 7\n预习 导数的定义',
};
const gens = new Map(probe.generations.map((g) => [g.index, g]));
const snapshots = [];
for (const p of probe.points) {
  const t = Math.floor(p.t);
  const text = FAKE_TEXT[t] ?? FAKE_TEXT[Math.round(p.t)];
  if (!text) continue;
  const name = `board_${String(p.index).padStart(4, '0')}_${String(t).padStart(6, '0')}.jpg`;
  const img = path.join(outDir, name);
  if (!fs.existsSync(img)) await grabFrame(video, p.t, img, { crop: p.roi || undefined, width: 1600 });
  snapshots.push({
    index: p.index, t: p.t, generation: p.generation,
    erased: !!gens.get(p.generation)?.erased,
    imagePath: img, imageName: name,
    ocr: { scene: 'board', title: text.split('\n')[0], text, layout: '上下分栏', confidence: 'high' },
  });
}

// 3) 模拟讲稿
const transcript = {
  segments: [
    { start: 3.2, end: 14.0, text: '这节课我们讲函数的连续性。先看定义，函数 f(x) 在 x0 处连续，意思是当 x 趋近于 x0 时，f(x) 的极限等于 f(x0)。' },
    { start: 15.0, end: 26.0, text: '我们再用一个例子来说明，证明 f(x) 等于 x 的平方处处连续，关键是把 x 平方减 x0 平方拆成 x 减 x0 乘以 x 加 x0。' },
    { start: 46.0, end: 58.0, text: '判断连续性一共三步。第一步，求极限；第二步，求函数值；第三步，比较两者是否相等。' },
    { start: 59.0, end: 70.0, text: '如果三者相等，函数在这个点就是连续的。做题的时候一定要注意先看定义域。' },
    { start: 97.0, end: 106.0, text: '今天的课后作业是第四十五页，习题三、五、七。下次课我们预习导数的定义。' },
  ],
};
transcript.text = transcript.segments.map((s) => `[${fmtTime(s.start)}] ${s.text}`).join('\n');

// 4) 整理成文
const cfg = loadConfig();
const doc = await synthesize({
  transcript, snapshots, duration: info.duration,
  meta: { title: '高等数学 · 函数的连续性', course: cfg.output.courseName || '高等数学' },
  cfg, cacheDir: path.join(workDir, 'notes'), onEvent: () => {}, concurrency: 3, bustCache: true,
});
console.log(`\n标题：${doc.title}`);
console.log(`章节 ${doc.sections.length} 个：${doc.sections.map((s) => s.title).join(' / ')}`);
console.log(`概览 ${doc.overview.length} 字，公式 ${doc.formulas.length} 字，术语 ${doc.glossary.length} 字，自测 ${doc.quiz.length} 字`);

// 5) 排版 → PDF
ensureKatexAssets();
const figures = path.join(outDir, 'figures');
fs.mkdirSync(figures, { recursive: true });
for (const s of doc.sections) for (const im of s.images) fs.copyFileSync(path.join(outDir, im.relPath), path.join(figures, im.relPath));
for (const it of doc.timeline) if (it.relPath) fs.copyFileSync(path.join(outDir, it.relPath), path.join(figures, it.relPath));
const rel = path.relative(outDir, ASSET_DIR).replace(/\\/g, '/');
const html = buildHtml(doc, {
  meta: { course: '高等数学', source: '(测试)', durationText: fmtTime(info.duration), transcriptChars: 500, transcript: transcript.segments },
  relativeAssets: rel, includeTranscript: true,
});
const htmlPath = path.join(outDir, 'notes.html');
fs.writeFileSync(htmlPath, html, 'utf8');
const pdf = await htmlToPdf({ htmlPath, pdfPath: path.join(outDir, 'test-notes.pdf'), onEvent: (e) => e.message && console.log('  ' + e.message) });
console.log('PDF：' + pdf + '  ' + (fs.statSync(pdf).size / 1024 / 1024).toFixed(2) + ' MB');
