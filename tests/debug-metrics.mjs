// 对比几种「板书内容量」指标，找出哪个最能反映「老师还在写」。
// 用法：node tests/debug-metrics.mjs <视频> <起秒> <止秒>
import path from 'node:path';
import { probeVideo } from '../app/lib/detect.mjs';
import { probeMedia } from '../app/lib/ingest.mjs';

const video = process.argv[2];
const from = Number(process.argv[3] || 0);
const to = Number(process.argv[4] || 120);
const info = await probeMedia(video);
const rows = [];
await probeVideo({
  video, width: info.width, height: info.height, duration: info.duration,
  options: { density: 'balanced' },
  onEvent: () => {},
  onFrame: (f) => rows.push(f),
});
console.log('   t   motion  inkTotal   bright   内容增长?');
let prevInk = null;
for (const f of rows) {
  if (f.t < from || f.t > to) continue;
  const grew = prevInk === null ? '' : (f.content > prevInk + 0.0008 ? '  ↑写了' : (Math.abs(f.content - prevInk) < 0.0008 ? '  —停' : '  ↓掉'));
  if (f.t % 2 === 0) console.log(`${String(f.t).padStart(4)}  ${f.motion.toFixed(4)}  ${(f.content ?? 0).toFixed(4)}  ${(f.bright ?? 0).toFixed(4)} ${grew}`);
  prevInk = f.content;
}
