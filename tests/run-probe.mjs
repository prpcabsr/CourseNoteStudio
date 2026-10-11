// 直接跑板书追踪，输出抓拍点表格（用于对照测试视频的已知板书时间）。
// 用法：node tests/run-probe.mjs [视频] [density]
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { probeVideo } from '../app/lib/detect.mjs';
import { probeMedia } from '../app/lib/ingest.mjs';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const video = process.argv[2] || path.join(ROOT, 'data', 'fixture', 'sample-lecture.mp4');
const density = process.argv[3] || 'balanced';

const info = await probeMedia(video);
console.log(`视频：${path.basename(video)}  ${info.width}×${info.height}  ${info.duration.toFixed(1)}s`);

const t0 = Date.now();
const r = await probeVideo({
  video,
  width: info.width,
  height: info.height,
  duration: info.duration,
  options: { density },
  onEvent: (e) => {
    if (e.type === 'log') console.log('  · ' + e.message);
    if (e.type === 'generation-end' && e.generation.snapshots !== undefined) {
      console.log(`  [板书 #${e.generation.index + 1}] ${e.generation.startTime.toFixed(0)}s - ${e.generation.endTime?.toFixed(0)}s  抓拍 ${e.generation.snapshots} 屏  ${e.generation.erased ? '★被擦除' : ''} (${e.generation.reason})`);
    }
  },
});
console.log(`\n扫描用时 ${((Date.now() - t0) / 1000).toFixed(1)}s，共 ${r.meta.frames} 帧（${density} 档）`);
console.log(`板书块数：${r.generations.length}，抓拍点：${r.points.length}，裁剪区域：${r.meta.crop ? JSON.stringify(r.meta.crop) : '整幅'}\n`);
console.log('  时间     板书#  原因        内容量   占本块峰值');
const peakByGen = new Map();
for (const p of r.points) peakByGen.set(p.generation, Math.max(peakByGen.get(p.generation) || 0, p.content || 0));
for (const p of r.points) {
  const peak = peakByGen.get(p.generation) || 1;
  const pct = Math.round(((p.content || 0) / peak) * 100);
  console.log(`  ${String(p.t).padStart(6)}s   #${p.generation + 1}    ${p.reason.padEnd(11)} ${(p.content ?? 0).toFixed(4)}   ${String(pct).padStart(3)}%`);
}
