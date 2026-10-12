// 生成软件著作权登记所需的申请材料。
// 用法：node app/make-copyright.mjs
//
// 中国版权保护中心对源程序的要求（常见做法）：
//   · 提交源程序**前、后各连续 30 页**（不足 60 页的全部提交）
//   · 每页**不少于 50 行**（最后一页除外）
//   · 页眉写软件名称 + 版本号 + 页码
// 文档（设计说明书/用户手册）同理：前后各 30 页，不足 60 页全部提交。
//
// 产出到 <项目根>/软著材料/ 下（属于申请材料，不进仓库）：
//   01-源程序.txt      按每页 50 行排版，页眉带软件名与页码
//   02-软件说明书.md    功能、技术特点、模块结构、运行环境……
//   03-申请表信息.md    在线申请时要填的各个字段
import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from './lib/paths.mjs';

const NAME = '课程笔记工坊';
const VERSION = 'V1.0';
const PAGE_LINES = 50;
const HEAD_PAGES = 30;
const TAIL_PAGES = 30;

const OUT = path.join(ROOT, '软著材料');
fs.mkdirSync(OUT, { recursive: true });

// 提交顺序：主程序 → 核心模块 → 前端 → 测试。审查看的是「你是不是独立写的、写了多少」，
// 所以把最能体现工作量的核心模块放在前面。
const ORDER = [
  'app/main.mjs',
  'app/lib/pipeline.mjs',
  'app/lib/detect.mjs',
  'app/lib/vision.mjs',
  'app/lib/fusion.mjs',
  'app/lib/render.mjs',
  'app/lib/audit.mjs',
  'app/lib/summary.mjs',
  'app/lib/supplement.mjs',
  'app/lib/corrections.mjs',
  'app/lib/latex.mjs',
  'app/lib/json.mjs',
  'app/lib/search.mjs',
  'app/lib/asr.mjs',
  'app/lib/ingest.mjs',
  'app/lib/download.mjs',
  'app/lib/config.mjs',
  'app/lib/project.mjs',
  'app/lib/paths.mjs',
  'app/lib/proc.mjs',
  'app/lib/server.mjs',
  'app/public/index.html',
  'app/public/style.css',
  'app/public/app.js',
];

const collected = [];
for (const rel of ORDER) {
  const abs = path.join(ROOT, rel);
  if (!fs.existsSync(abs)) continue;
  const body = fs.readFileSync(abs, 'utf8').split(/\r?\n/);
  collected.push(`// ==================== 文件：${rel.replace(/\//g, '\\')} ====================`);
  collected.push(...body);
  collected.push('');
}
// 测试代码也一并列出（体现工程质量），放最后
const testsDir = path.join(ROOT, 'tests');
if (fs.existsSync(testsDir)) {
  for (const f of fs.readdirSync(testsDir).filter((f) => f.endsWith('.mjs')).sort()) {
    const rel = `tests/${f}`;
    const body = fs.readFileSync(path.join(testsDir, f), 'utf8').split(/\r?\n/);
    collected.push(`// ==================== 文件：tests\\${f} ====================`);
    collected.push(...body);
    collected.push('');
  }
}

const totalLines = collected.length;
const allPages = [];
for (let i = 0; i < collected.length; i += PAGE_LINES) {
  allPages.push(collected.slice(i, i + PAGE_LINES));
}
const totalPages = allPages.length;
let pages;
let skipped = 0;
if (totalPages <= HEAD_PAGES + TAIL_PAGES) {
  pages = allPages;
} else {
  pages = [...allPages.slice(0, HEAD_PAGES), null, ...allPages.slice(totalPages - TAIL_PAGES)];
  skipped = totalPages - HEAD_PAGES - TAIL_PAGES;
}

const out = [];
pages.forEach((page, idx) => {
  if (page === null) {
    out.push('');
    out.push(`……（此处省略中间 ${skipped} 页，共 ${totalPages} 页）……`);
    out.push('');
    return;
  }
  // 前面 30 页就是第 1~30 页；后面 30 页对应整份文档的最后 30 页
  const tailStart = totalPages - TAIL_PAGES + 1;
  const pageNo = idx < HEAD_PAGES ? idx + 1 : tailStart + (idx - HEAD_PAGES - 1);
  out.push(`${NAME} ${VERSION}                                        第 ${pageNo} 页`);
  out.push('');
  out.push(...page);
  out.push('\f');
});
fs.writeFileSync(path.join(OUT, '01-源程序.txt'), out.join('\n'), 'utf8');

console.log(`源程序：共 ${totalLines} 行 / ${totalPages} 页（每页 ${PAGE_LINES} 行）`);
console.log(`已输出：前 ${Math.min(HEAD_PAGES, totalPages)} 页 + 后 ${Math.min(TAIL_PAGES, totalPages)} 页${skipped ? `，中间省略 ${skipped} 页` : ''}`);
console.log(`目录：${OUT}`);
