// 单独验证视觉模型：启动 llama-server 并识别一张板书截图。
// 用法：node tests/vlm-check.mjs [图片]
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readBoardImage, ensureLocalServer, vlmAssets, stopLocalServer } from '../app/lib/vision.mjs';
import { grabFrame } from '../app/lib/proc.mjs';
import { probeVideo } from '../app/lib/detect.mjs';
import { probeMedia } from '../app/lib/ingest.mjs';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const video = path.join(ROOT, 'data', 'fixture', 'sample-lecture.mp4');
const img = process.argv[2] || path.join(ROOT, 'data', 'fixture', 'out', 'vlm-check.jpg');
if (!process.argv[2]) {
  const info = await probeMedia(video);
  const probe = await probeVideo({ video, width: info.width, height: info.height, duration: info.duration, options: { density: 'balanced' }, onEvent: () => {} });
  const p = probe.points.find((x) => x.t > 30) || probe.points.at(-1);
  console.log('抓拍点：', p.t + 's，裁剪：', JSON.stringify(p.roi));
  await grabFrame(video, p.t, img, { crop: p.roi || undefined, width: 1600 });
}
const a = vlmAssets('vlm-qwen3vl-4b');
console.log('模型：', a.label, a.ready ? '就绪' : '缺失');
const t0 = Date.now();
await ensureLocalServer({ modelId: 'vlm-qwen3vl-4b', gpuLayers: 99, ctxSize: 8192, onEvent: (e) => e.message && console.log('  ' + e.message) });
const r = await readBoardImage({
  imagePath: img,
  cfg: { mode: 'local', modelId: 'vlm-qwen3vl-4b', gpuLayers: 99, ctxSize: 8192, maxTokens: 900 },
  onEvent: () => {},
});
console.log(`\n用时 ${((Date.now() - t0) / 1000).toFixed(1)}s`);
console.log('scene =', r.scene, '| confidence =', r.confidence, '| degraded =', !!r.degraded);
console.log('title =', r.title);
console.log('layout =', r.layout);
console.log('--- text ---');
console.log(r.text);
stopLocalServer();
