// 检查界面结构：导出 PDF 按钮、全屏入口、全屏里的 AI 侧边栏是否都在。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const html = fs.readFileSync(path.join(ROOT, 'app', 'public', 'index.html'), 'utf8');
const js = fs.readFileSync(path.join(ROOT, 'app', 'public', 'app.js'), 'utf8');
const css = fs.readFileSync(path.join(ROOT, 'app', 'public', 'style.css'), 'utf8');

const checks = [
  ['导出 PDF 按钮', html.includes('id="btnExportPdf"')],
  ['全屏按钮固定在预览右上角', html.includes('id="btnPreviewFs"') && css.includes('.preview-fs')],
  ['全屏浮层', html.includes('id="fsOverlay"') && css.includes('.fs-overlay')],
  ['全屏里的 AI 侧边栏', html.includes('id="fsAi"') && html.includes('id="fsAiSlot"')],
  ['全屏里的窄边呼出条', html.includes('id="fsRail"') && css.includes('.fs-rail')],
  ['Esc 退出全屏', js.includes("e.key === 'Escape'")],
  ['AI 面板可搬进全屏再搬回', js.includes('aiDockHome') && js.includes('fsAiShow')],
  ['批注跟随全屏 iframe', js.includes('activePreviewFrame')],
  ['导出走新接口', js.includes('/export-pdf')],
  ['未自动生成 PDF', !js.includes('自动生成 PDF')],
];

let bad = 0;
for (const [name, ok] of checks) {
  if (!ok) bad++;
  console.log(`${ok ? '✓' : '✗'} ${name}`);
}
console.log(bad ? `\n✗ ${bad} 项缺失` : '\n✓ 界面结构完整');
process.exit(bad ? 1 : 0);
