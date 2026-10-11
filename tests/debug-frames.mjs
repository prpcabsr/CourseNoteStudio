// 调参用：打印每帧的 motion / refDiff / 墨迹，便于定位误判。
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { probeVideo } from '../app/lib/detect.mjs';
import { probeMedia } from '../app/lib/ingest.mjs';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const video = process.argv[2] || path.join(ROOT, 'data', 'fixture', 'sample-lecture.mp4');
const info = await probeMedia(video);
const rows = [];
await probeVideo({
  video, width: info.width, height: info.height, duration: info.duration,
  options: { density: 'balanced' },
  onEvent: () => {},
  onFrame: (f) => rows.push(f),
});
console.log('   t   motion   refDiff  content  moving  shift');
for (const f of rows) {
  const mark = f.isMoving ? '  ...' : '';
  console.log(`${String(f.t).padStart(4)}  ${f.motion.toFixed(4)}  ${f.refDiff.toFixed(4)}  ${(f.content ?? 0).toFixed(4)}  ${f.isMoving ? 'Y' : '.'}  ${f.shift ? f.shift.dx + ',' + f.shift.dy : ''}${mark}`);
}
