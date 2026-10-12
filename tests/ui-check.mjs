// 检查界面结构：导出 PDF 按钮、全屏入口、全屏里的 AI 侧边栏是否都在。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const html = fs.readFileSync(path.join(ROOT, 'app', 'public', 'index.html'), 'utf8');
const js = fs.readFileSync(path.join(ROOT, 'app', 'public', 'app.js'), 'utf8');
const css = fs.readFileSync(path.join(ROOT, 'app', 'public', 'style.css'), 'utf8');
const server = fs.readFileSync(path.join(ROOT, 'app', 'lib', 'server.mjs'), 'utf8');

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
  ['全屏缩放控件', html.includes('id="fsZoomIn"') && html.includes('id="fsZoomOut"') && html.includes('id="fsZoomFit"')],
  ['全屏呈现成 A4 纸', js.includes('applyFsChrome') && js.includes('210mm')],
  ['外观设置同时注入预览与全屏', js.includes("['#previewFrame', '#fsFrame']")],
  ['全屏 iframe 载入后补画外观与批注', js.includes('applyFsChrome();') && js.includes("hookAuditFlags($('#fsFrame').contentDocument)")],
  ['已移除「打开 PDF」按钮', !html.includes('id="btnPdf"')],
  ['外观改动自动存为默认', js.includes('scheduleLookSave')],
  ['外观 CSS 由服务端统一提供', js.includes('/api/look.css')],
  ['预览与 PDF 共用同一份外观 CSS', js.includes('fetchLookCss')],
  ['全屏「了解更多」有就地讲解面板', html.includes('id="fsDetail"') && js.includes('showFsDetail')],
  ['Esc 逐层关闭（讲解→AI→全屏）', /hideFsDetail\(\)[\s\S]{0,90}fsAiShow\(false\)[\s\S]{0,90}exitFullscreenPreview/.test(js)],
  ['批注箭头指向具体句子（Range 定位）', js.includes('anchorRange') && js.includes('getClientRects')],
  ['句子下面画下划线标记', js.includes('一眼看出箭头指的是哪一句')],
  ['全屏铺满底纸（不再做成卡片）', !js.includes('e9edf3')],
  ['批注固定在右侧留白（不压正文）', js.includes('noteLeft = contentRight')],
  ['连线沿右侧留白走（不横穿正文）', js.includes('function curvePath') && js.includes('marginX')],
  ['连线终点抬到行上沿（走行间空隙）', js.includes('firstRect.top : anchorRect.top')],
  ['只信够宽的 rect（避免锚点错位）', js.includes('r.width > 24')],
  ['批注文字行高跟随格子', js.includes('line-height: var(--rule-h, 24px)')],
  ['全屏保留批注留白（不被清掉）', js.includes('body.ai-supp-on { padding-right: 300px !important; }')],
  ['补充讲解里右键也能问 AI', js.includes("el.closest('.supp-item, .fs-detail-body')")],
  ['AI 回答里右键可追问', js.includes("el.closest('.ai-msg')")],
  ['全屏 iframe 也挂了右键菜单', js.includes("hookFrame($('#fsFrame'))")],
  ['红标可点击弹说明', js.includes('function showErrCard') && js.includes('hookAuditFlags')],
  ['审校徽标可跳转到红标', js.includes('function gotoAuditFlag') && html.includes('id="auditBadge"')],
  ['红标在关掉批注后仍可点（独立于批注层）', js.includes('红标是烧在成稿里的，和批注开关无关')],
  ['审校已改成自动（没有手动按钮）', !html.includes('id="btnAudit"') && js.includes('function renderAuditBadge')],
  ['重新排版会自动补做审校', server.includes('这份成稿还没审校过')],
  ['静态资源禁用缓存（改了代码不会看到旧界面）', server.includes("'cache-control': 'no-store, must-revalidate'")],
];

let bad = 0;
for (const [name, ok] of checks) {
  if (!ok) bad++;
  console.log(`${ok ? '✓' : '✗'} ${name}`);
}
console.log(bad ? `\n✗ ${bad} 项缺失` : '\n✓ 界面结构完整');
process.exit(bad ? 1 : 0);
