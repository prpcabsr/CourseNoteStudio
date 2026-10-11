// 把 PDF 的某几页渲染成 PNG，用来肉眼核对最终成稿（公式、版面）。
// 用法：node tests/pdf-render.mjs <pdf路径> [起始页] [结束页] [缩放]
import fs from 'node:fs';
import path from 'node:path';
import * as mupdf from 'mupdf';
import { DATA_DIR } from '../app/lib/paths.mjs';

const pdfPath = process.argv[2];
if (!pdfPath || !fs.existsSync(pdfPath)) {
  console.error('用法：node tests/pdf-render.mjs <pdf路径> [起页] [止页] [缩放]');
  process.exit(1);
}
const from = Number(process.argv[3] || 1);
const to = Number(process.argv[4] || from);
const scale = Number(process.argv[5] || 1.4);

const doc = mupdf.Document.openDocument(fs.readFileSync(pdfPath), 'application/pdf');
const total = doc.countPages();
console.log(`PDF 共 ${total} 页，渲染第 ${from}-${Math.min(to, total)} 页`);

const outDir = path.join(DATA_DIR, 'pdfpages');
fs.mkdirSync(outDir, { recursive: true });
for (let i = from; i <= Math.min(to, total); i++) {
  const page = doc.loadPage(i - 1);
  const pix = page.toPixmap(mupdf.Matrix.scale(scale, scale), mupdf.ColorSpace.DeviceRGB, false, true);
  const png = pix.asPNG();
  const file = path.join(outDir, `page-${String(i).padStart(3, '0')}.png`);
  fs.writeFileSync(file, png);
  console.log('  ' + file + `  ${Math.round(png.length / 1024)} KB`);
}
