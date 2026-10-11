// 「成稿」：Markdown + 板书图片 → 排版精美的 HTML → 用 Edge 无头模式打印成 PDF。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { marked } from 'marked';
import katex from 'katex';
import { run } from './proc.mjs';
import { findEdge, ROOT, DATA_DIR } from './paths.mjs';
import { fmtTime } from './fusion.mjs';
import { repairLatex } from './latex.mjs';

const KATEX_SRC = path.join(ROOT, 'node_modules', 'katex', 'dist');
export const ASSET_DIR = path.join(DATA_DIR, 'assets', 'katex');

/** 把 KaTeX 的 css/字体/脚本复制到 data/assets，供网页与 HTML 离线引用。 */
export function ensureKatexAssets() {
  fs.mkdirSync(ASSET_DIR, { recursive: true });
  const copy = (from, to) => {
    if (!fs.existsSync(to)) fs.copyFileSync(from, to);
  };
  copy(path.join(KATEX_SRC, 'katex.min.css'), path.join(ASSET_DIR, 'katex.min.css'));
  copy(path.join(KATEX_SRC, 'katex.min.js'), path.join(ASSET_DIR, 'katex.min.js'));
  const autoSrc = path.join(KATEX_SRC, 'contrib', 'auto-render.min.js');
  if (fs.existsSync(autoSrc)) copy(autoSrc, path.join(ASSET_DIR, 'auto-render.min.js'));
  const fontsSrc = path.join(KATEX_SRC, 'fonts');
  const fontsDst = path.join(ASSET_DIR, 'fonts');
  fs.mkdirSync(fontsDst, { recursive: true });
  for (const f of fs.readdirSync(fontsSrc)) copy(path.join(fontsSrc, f), path.join(fontsDst, f));
  return ASSET_DIR;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

/** 统一数学公式写法：把 \[..\]、\(..\)、以及漏写 $ 的裸 LaTeX 都规范成 $$..$$ / $..$。 */
export function normalizeMath(md) {
  return repairLatex(
    String(md)
      .replace(/\\\[([\s\S]+?)\\\]/g, (_, t) => `\n$$${t}$$\n`)
      .replace(/\\\(([\s\S]+?)\\\)/g, (_, t) => `$${t}$`),
  );
}

/** 先把数学公式替换成占位符，避免被 Markdown 解析器弄乱。 */
function protectMath(md) {
  const store = [];
  let out = normalizeMath(md).replace(/\$\$([\s\S]+?)\$\$/g, (_, tex) => {
    store.push({ tex, display: true });
    return `\n\nMATHPLACEHOLDER${store.length - 1}ENDMATH\n\n`;
  });
  out = out.replace(/(?<!\\)\$(?!\s)([^\n$]+?)(?<!\\)\$/g, (_, tex) => {
    store.push({ tex, display: false });
    return `MATHPLACEHOLDER${store.length - 1}ENDMATH`;
  });
  return { out, store };
}

function restoreMath(html, store) {
  return html.replace(/MATHPLACEHOLDER(\d+)ENDMATH/g, (_, i) => {
    const m = store[Number(i)];
    if (!m) return '';
    try {
      // KaTeX 没有 ▢ 的字形，替换成它支持的 \square，避免控制台告警与缺字
      const tex = m.tex.trim().replace(/▢/g, '\\square ');
      return katex.renderToString(tex, { displayMode: m.display, throwOnError: false, output: 'html', strict: 'ignore' });
    } catch {
      return `<code>${escapeHtml(m.tex)}</code>`;
    }
  });
}

export function mdToHtml(md) {
  if (!md) return '';
  const { out, store } = protectMath(String(md));
  const html = marked.parse(out, { gfm: true, breaks: false });
  return restoreMath(html, store);
}

/**
 * 纯文本（板书转录、讲稿）转 HTML：保留换行、转义 HTML，但把数学公式正常排版。
 * inlineMath=true 时把 $$..$$ 当行内公式处理（用于窄栏，避免公式被撑破）。
 */
export function textToHtml(text, { inlineMath = false } = {}) {
  if (!text) return '';
  let src = String(text);
  if (inlineMath) src = src.replace(/\$\$([\s\S]+?)\$\$/g, (_, t) => `$${t.trim()}$`);
  const { out, store } = protectMath(src);
  const html = escapeHtml(out).replace(/MATHPLACEHOLDER(\d+)ENDMATH/g, (_, i) => {
    const m = store[Number(i)];
    if (!m) return '';
    try {
      return katex.renderToString(m.tex.trim(), { displayMode: false, throwOnError: false, output: 'html', strict: 'ignore' });
    } catch {
      return `<code>${escapeHtml(m.tex)}</code>`;
    }
  });
  return html.replace(/\n/g, '<br>');
}

const CSS = (opts = {}) => `
:root { --ink:#1a1a1a; --sub:#5b6472; --line:#e2e6ec; --accent:#1f6feb; --accent2:#0b4ea2; --board:#f5f2e9; }
* { box-sizing: border-box; }
html { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
body {
  margin:0; color:var(--ink); background:#fff;
  font-family:"Microsoft YaHei","PingFang SC","Source Han Sans SC","Segoe UI",system-ui,sans-serif;
  font-size:10.8pt; line-height:1.72; letter-spacing:.01em;
}
.page { max-width: 190mm; margin: 0 auto; padding: 0 2mm; }
h1,h2,h3,h4 { line-height:1.35; font-weight:700; color:#101418; }
h1 { font-size:22pt; margin:0 0 6pt; }
h2 { font-size:15pt; margin:20pt 0 8pt; padding-bottom:5pt; border-bottom:2px solid var(--accent); }
h3 { font-size:12.4pt; margin:14pt 0 5pt; padding-left:7pt; border-left:3px solid var(--accent); }
h4 { font-size:11pt; margin:10pt 0 4pt; color:#243043; }
p { margin:5pt 0; }
ul,ol { margin:5pt 0 5pt 0; padding-left:18pt; }
li { margin:2.5pt 0; }
strong { color:#0b2545; }
code { background:#f2f4f8; padding:1px 4px; border-radius:3px; font-family:"Cascadia Mono",Consolas,monospace; font-size:9.4pt; }
pre { background:#f7f8fa; border:1px solid var(--line); border-radius:6px; padding:8pt; overflow:auto; font-size:9pt; }
blockquote { margin:6pt 0; padding:6pt 10pt; border-left:3px solid #c8d2e0; background:#f7f9fc; color:#334; }
table { border-collapse:collapse; width:100%; margin:8pt 0; font-size:9.8pt; }
th,td { border:1px solid var(--line); padding:4.5pt 7pt; text-align:left; vertical-align:top; }
th { background:#eef3fb; font-weight:600; }
hr { border:none; border-top:1px solid var(--line); margin:14pt 0; }

/* 封面 */
.cover { padding: 26mm 0 10mm; }
.cover .badge { display:inline-block; font-size:9pt; letter-spacing:.22em; color:var(--accent2); border:1px solid var(--accent); border-radius:99px; padding:3pt 12pt; margin-bottom:14pt; }
.cover .sub { color:var(--sub); font-size:12pt; margin-top:4pt; }
.cover .rule { height:3px; width:64px; background:var(--accent); margin:16pt 0; }
.meta-table { margin-top:16pt; font-size:9.6pt; color:#3b4657; }
.meta-table td { border:none; padding:2.5pt 0; }
.meta-table td:first-child { color:var(--sub); width:88px; }
.stat-row { display:flex; gap:10pt; margin-top:18pt; }
.stat { flex:1; border:1px solid var(--line); border-radius:8px; padding:8pt 10pt; background:#fbfcfe; }
.stat b { display:block; font-size:15pt; color:var(--accent2); }
.stat span { font-size:8.6pt; color:var(--sub); }

/* 目录 */
.toc { margin-top:8pt; }
.toc ol { padding-left:16pt; }
.toc li { margin:3pt 0; }
.toc .t { color:#16243a; }
.toc .p { color:var(--sub); font-size:9pt; }

.section { margin-top:16pt; }
.section-head { display:flex; align-items:baseline; gap:8pt; }
.sec-no { color:#fff; background:var(--accent); border-radius:6px; font-size:10pt; padding:1pt 7pt; font-weight:700; }
.sec-time { color:var(--sub); font-size:8.8pt; }

figure { margin:10pt 0; border:1px solid var(--line); border-radius:8px; overflow:hidden; background:var(--board); page-break-inside:avoid; break-inside:avoid; }
figure img { width:100%; display:block; }
figcaption { font-size:8.8pt; color:#46505f; padding:5pt 8pt; background:#fff; border-top:1px solid var(--line); display:flex; gap:6pt; align-items:center; }
.tag { font-size:8pt; border-radius:4px; padding:1pt 5pt; }
.tag.erase { background:#ffe9e6; color:#a3341f; border:1px solid #f3c4bb; }
.tag.keep { background:#e8f3ff; color:#1c5aa8; border:1px solid #c3dcf7; }
.tag.time { background:#f1f3f6; color:#4c5766; border:1px solid #e0e4ea; margin-left:auto; }

.callout { border:1px solid #d8e3f3; background:#f6faff; border-radius:8px; padding:8pt 11pt; margin:10pt 0; }
.callout h4 { margin-top:0; color:var(--accent2); }
.grid2 { display:flex; gap:10pt; }
.grid2 > * { flex:1; }
.appendix { page-break-before:always; }
.board-group { margin-bottom: 14pt; page-break-inside:avoid; break-inside:avoid; }
.board-group h3 { border-left:3px solid var(--accent); padding-left:8pt; }
.timespan { color:var(--sub); font-size:9pt; font-weight:400; }
.timeline-text { column-count:2; column-gap:18pt; font-size:9.4pt; line-height:1.62; color:#39424f; }
.tl-item { break-inside:avoid; margin-bottom:6pt; }
.tl-item + .tl-item { border-top:1px dashed var(--line); padding-top:5pt; }
.tl-item b { color:var(--accent2); font-family:var(--mono); font-size:9pt; }
.tl-body { white-space:pre-wrap; overflow-wrap:anywhere; word-break:break-word; }
.tl-body .katex { font-size:1em; }
.fig-label { font-size:9pt; color:var(--sub); margin:12pt 0 4pt; border-top:1px dashed var(--line); padding-top:6pt; }
.board-group figure img { max-height: 74mm; object-fit: contain; margin:0 auto; }
.transcript { font-size:8.8pt; color:#3b4657; column-count:2; column-gap:14pt; }
.transcript div { break-inside:avoid; margin-bottom:2pt; }
.footer-note { margin-top:24pt; padding-top:8pt; border-top:1px solid var(--line); color:var(--sub); font-size:8.6pt; }
@page { size:${opts.paper || 'A4'}; margin:16mm 14mm 15mm; }
@media print { .page { max-width:none; padding:0; } h2 { page-break-after:avoid; } h3 { page-break-after:avoid; } }
`;

function figCaption(img) {
  const tags = [];
  if (img.erased) tags.push('<span class="tag erase">此板书之后被擦除</span>');
  else tags.push('<span class="tag keep">板书</span>');
  tags.push(`<span class="tag time">${fmtTime(img.t)}</span>`);
  const title = img.title ? escapeHtml(img.title) + ' · ' : '';
  return `<figcaption><span>${title}第 ${img.generation + 1} 块板书</span>${tags.join('')}</figcaption>`;
}

function erasedGenerations(timeline) {
  return new Set(timeline.filter((t) => t.erased).map((t) => t.generation)).size;
}

let katexCssCache = null;
/**
 * 把 KaTeX 样式（含 woff2 字体）内联成一段 CSS。
 * 这样生成的 HTML 是自包含的：无论用 iframe 预览、直接打开文件、还是打印成 PDF，
 * 都不会因为外部样式表没加载上而出现「上下标变成普通大小、挤在符号旁边」的问题。
 */
export function inlineKatexCss() {
  if (katexCssCache) return katexCssCache;
  ensureKatexAssets();
  let css = fs.readFileSync(path.join(ASSET_DIR, 'katex.min.css'), 'utf8');
  css = css.replace(/url\((['"]?)fonts\/([^)'"]+)\1\)/g, (whole, _q, file) => {
    if (!/\.woff2$/i.test(file)) return whole; // 只内嵌 woff2，其余保留原样作为兜底
    const p = path.join(ASSET_DIR, 'fonts', file);
    if (!fs.existsSync(p)) return whole;
    return `url(data:font/woff2;base64,${fs.readFileSync(p).toString('base64')})`;
  });
  katexCssCache = css;
  return css;
}

/** 生成完整 HTML 文档。
 *  PDF 以「整洁、核心明确」为目标：默认不放板书截图、不放板书时间线、不放讲稿，
 *  这些内容都在网页的「笔记章节」里看。需要的话可在设置里打开。 */
export function buildHtml(
  doc,
  { meta, relativeAssets = 'assets/katex', includeTranscript = false, includeBoardImages = false, includeBoardTimeline = false, inlineAssets = true },
) {
  const parts = [];
  parts.push('<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">');
  parts.push(`<title>${escapeHtml(doc.title || '课程笔记')}</title>`);
  if (inlineAssets) parts.push(`<style>${inlineKatexCss()}</style>`);
  else parts.push(`<link rel="stylesheet" href="${relativeAssets}/katex.min.css">`);
  parts.push(`<style>${CSS({ paper: meta.paper })}</style>`);
  parts.push('</head><body><div class="page">');

  // 封面
  parts.push('<section class="cover">');
  parts.push('<div class="badge">课 程 笔 记</div>');
  parts.push(`<h1>${escapeHtml(doc.title || meta.title || '课程笔记')}</h1>`);
  if (doc.subtitle) parts.push(`<div class="sub">${escapeHtml(doc.subtitle)}</div>`);
  parts.push('<div class="rule"></div>');
  const rows = [];
  if (meta.course) rows.push(['课程', meta.course]);
  if (meta.source) rows.push(['来源', `<a href="${escapeHtml(meta.source)}">${escapeHtml(meta.source)}</a>`]);
  if (meta.durationText) rows.push(['时长', meta.durationText]);
  rows.push(['生成时间', new Date().toLocaleString('zh-CN')]);
  rows.push(['生成方式', '课程笔记工坊 · 板书逐帧追踪 + 语音识别 + 模型整理']);
  parts.push(`<table class="meta-table">${rows.map((r) => `<tr><td>${r[0]}</td><td>${r[1]}</td></tr>`).join('')}</table>`);
  parts.push('<div class="stat-row">');
  parts.push(`<div class="stat"><b>${doc.sections.filter((s) => s.markdown.replace(/^#.*$/gm, '').trim().length > 40).length}</b><span>笔记章节</span></div>`);
  parts.push(`<div class="stat"><b>${doc.timeline.length}</b><span>板书快照</span></div>`);
  parts.push(`<div class="stat"><b>${erasedGenerations(doc.timeline)}</b><span>擦除前保存的板书块</span></div>`);
  parts.push(`<div class="stat"><b>${meta.transcriptChars ? Math.round(meta.transcriptChars / 1000) + 'k' : '—'}</b><span>讲稿字数</span></div>`);
  parts.push('</div></section>');

  // 概览
  if (doc.overview) {
    parts.push('<section class="callout"><h4>本讲概览</h4>' + mdToHtml(doc.overview) + '</section>');
  }
  if (doc.objectives?.length) {
    parts.push('<section class="callout"><h4>学习目标</h4><ul>' + doc.objectives.map((o) => `<li>${mdToHtml(String(o)).replace(/^<p>|<\/p>\s*$/g, '')}</li>`).join('') + '</ul></section>');
  }

  // 目录
  const named = doc.sections.filter((s) => s.markdown.replace(/^#.*$/gm, '').trim().length > 40);
  if (named.length) {
    parts.push('<section class="toc"><h2>目录</h2><ol>');
    for (const s of named) {
      parts.push(`<li><span class="t">${escapeHtml(s.title)}</span> <span class="p">（${fmtTime(s.start)}）</span></li>`);
    }
    parts.push('</ol></section>');
  }

  // 正文
  for (const s of doc.sections) {
    const body = s.markdown.replace(/^#{1,3}\s*.+$/m, '').trim();
    if (!body && !s.images.length) continue;
    parts.push('<section class="section">');
    parts.push(`<h2 class="section-head"><span class="sec-no">${String(s.index + 1).padStart(2, '0')}</span><span>${escapeHtml(s.title)}</span><span class="sec-time">${fmtTime(s.start)} – ${fmtTime(s.end)}</span></h2>`);
    parts.push(mdToHtml(body));
    if (includeBoardImages && s.images.length) {
      parts.push('<div class="fig-label">本节板书原图</div>');
      for (const img of s.images) {
        parts.push(`<figure><img src="figures/${escapeHtml(img.relPath)}" alt="板书 ${fmtTime(img.t)}">${figCaption(img)}</figure>`);
      }
    }
    parts.push('</section>');
  }

  // 关键公式 / 术语
  if (doc.formulas && doc.formulas.trim()) {
    parts.push('<section class="section"><h2>关键公式与定理</h2>' + mdToHtml(doc.formulas) + '</section>');
  }
  if (doc.glossary && doc.glossary.trim()) {
    parts.push('<section class="section"><h2>术语表</h2>' + mdToHtml(doc.glossary) + '</section>');
  }
  if (doc.quiz && doc.quiz.trim()) {
    parts.push('<section class="section"><h2>复习自测</h2>' + mdToHtml(doc.quiz) + '</section>');
  }

  // 附录：板书时间线（按板书块分组：每块给一张最完整的截图 + 全部识别文字）
  if (includeBoardTimeline && doc.timeline.length) {
    parts.push('<section class="appendix"><h2>附录 A · 板书全时间线</h2>');
    parts.push('<p style="color:#5b6472;font-size:9pt">按时间顺序列出每一屏板书。标记「此板书之后被擦除」的，是程序在老师擦掉它之前抓取保存的完整内容；因此即使黑板上已经看不到，笔记里依然查得到。</p>');
    const groups = new Map();
    for (const item of doc.timeline) {
      const arr = groups.get(item.generation) || [];
      arr.push(item);
      groups.set(item.generation, arr);
    }
    for (const [gen, items] of [...groups.entries()].sort((a, b) => a[0] - b[0])) {
      const first = items[0];
      const last = items[items.length - 1];
      const erased = items.some((i) => i.erased);
      parts.push('<div class="board-group">');
      parts.push(
        `<h3>第 ${gen + 1} 块板书　<span class="timespan">${fmtTime(first.t)} – ${fmtTime(last.t)}</span> ${erased ? '<span class="tag erase">之后被擦除，内容已保存</span>' : '<span class="tag keep">课堂末仍保留</span>'}`,
      );
      const shot = items.find((i) => i.relPath && i === last) || items.find((i) => i.relPath);
      if (shot?.relPath) {
        parts.push(`<figure><img src="figures/${escapeHtml(shot.relPath)}" alt="板书 ${fmtTime(shot.t)}"><figcaption><span>这一块板书最完整的一屏</span><span class="tag time">${fmtTime(shot.t)}</span></figcaption></figure>`);
      }
      parts.push('<div class="timeline-text">');
      for (const it of items) {
        parts.push(`<div class="tl-item"><b>${fmtTime(it.t)}</b>${it.title ? ` · ${escapeHtml(it.title)}` : ''}<div class="tl-body">${textToHtml(it.text.slice(0, 1500), { inlineMath: true })}</div></div>`);
      }
      parts.push('</div>');
      parts.push('</div>');
    }
    parts.push('</section>');
  }

  // 附录：讲稿
  if (includeTranscript && meta.transcript?.length) {
    parts.push('<section class="appendix"><h2>附录 B · 课堂讲稿（自动转写）</h2>');
    parts.push('<div class="transcript">');
    for (const seg of meta.transcript) {
      parts.push(`<div><b>${fmtTime(seg.start)}</b> ${escapeHtml(seg.text)}</div>`);
    }
    parts.push('</div></section>');
  }

  parts.push('<div class="footer-note">本笔记由「课程笔记工坊」自动生成：板书按秒级画面变化逐帧追踪（擦除前的内容会被保留），语音经本地模型转写，再由大模型按逻辑整理。自动识别难免有误，公式与关键结论建议对照原视频复核。</div>');  parts.push('</div></body></html>');
  return parts.join('\n');
}

/** 用 Edge 无头模式把 HTML 打印成 PDF。 */
export async function htmlToPdf({ htmlPath, pdfPath, onEvent = () => {} }) {
  const edge = findEdge();
  if (!edge) throw new Error('未找到 Microsoft Edge，无法生成 PDF');
  if (fs.existsSync(pdfPath)) fs.rmSync(pdfPath, { force: true });
  const url = 'file:///' + htmlPath.replace(/\\/g, '/').replace(/^\//, '');
  const r = await run(
    edge,
    [
      '--headless=new',
      '--disable-gpu',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-extensions',
      '--run-all-compositor-stages-before-draw',
      '--virtual-time-budget=20000',
      '--no-pdf-header-footer',
      `--print-to-pdf=${pdfPath}`,
      url,
    ],
    { timeoutMs: 300000 },
  );
  if (!fs.existsSync(pdfPath) || fs.statSync(pdfPath).size < 1000) {
    throw new Error(`PDF 生成失败：${(r.stderr || '').slice(0, 300) || 'Edge 未输出文件'}`);
  }
  onEvent({ type: 'log', message: `PDF 已生成：${path.basename(pdfPath)}（${(fs.statSync(pdfPath).size / 1024 / 1024).toFixed(1)} MB）` });
  return pdfPath;
}

/** Markdown 版本导出。 */
export function buildMarkdown(doc, meta) {
  const out = [];
  out.push(`# ${doc.title}`);
  if (doc.subtitle) out.push(`> ${doc.subtitle}`);
  out.push('');
  out.push(`- 课程：${meta.course || '—'}`);
  if (meta.source) out.push(`- 来源：${meta.source}`);
  if (meta.durationText) out.push(`- 时长：${meta.durationText}`);
  out.push(`- 生成时间：${new Date().toLocaleString('zh-CN')}`);
  out.push('');
  if (doc.overview) out.push('## 本讲概览\n\n' + doc.overview);
  if (doc.objectives?.length) out.push('## 学习目标\n\n' + doc.objectives.map((o) => `- ${o}`).join('\n'));
  for (const s of doc.sections) {
    const body = s.markdown.replace(/^#{1,3}\s*.+$/m, '').trim();
    if (!body && !s.images.length) continue;
    out.push(`\n## ${s.index + 1}. ${s.title}\n`);
    out.push(body);
    for (const img of s.images) out.push(`\n![板书 ${fmtTime(img.t)}](figures/${img.relPath})\n`);
  }
  if (doc.formulas?.trim()) out.push('\n## 关键公式与定理\n\n' + doc.formulas);
  if (doc.glossary?.trim()) out.push('\n## 术语表\n\n' + doc.glossary);
  if (doc.quiz?.trim()) out.push('\n## 复习自测\n\n' + doc.quiz);
  return out.join('\n');
}
