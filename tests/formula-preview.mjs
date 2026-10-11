// 把真实笔记里的某一段单独渲染成图片，用来肉眼核对公式排版。
// 用法：node tests/formula-preview.mjs [项目id] [起始行] [结束行]
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { mdToHtml, ensureKatexAssets, ASSET_DIR } from '../app/lib/render.mjs';
import { findEdge, DATA_DIR } from '../app/lib/paths.mjs';
import { projectPaths, listProjects } from '../app/lib/project.mjs';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const id = process.argv[2] || listProjects()[0].id;
const from = Number(process.argv[3] || 90);
const to = Number(process.argv[4] || 110);

const P = projectPaths(id);
const md = fs.readFileSync(path.join(P.out, 'notes.md'), 'utf8').split(/\r?\n/).slice(from - 1, to).join('\n');
console.log('片段预览：\n' + md.split('\n').slice(0, 4).join('\n') + '\n…');

ensureKatexAssets();
const rel = path.relative(DATA_DIR, ASSET_DIR).replace(/\\/g, '/');
const html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<link rel="stylesheet" href="${rel}/katex.min.css">
<style>
body{font-family:"Microsoft YaHei",sans-serif;font-size:15px;line-height:1.8;color:#1a1a1a;margin:0;padding:24px 28px;background:#fff;max-width:1000px}
h2{font-size:18px;border-bottom:2px solid #2f6bff;padding-bottom:4px}
h3{font-size:15px;border-left:3px solid #2f6bff;padding-left:8px;margin-top:18px}
.katex-display{margin:12px 0}
</style></head><body>${mdToHtml(md)}</body></html>`;
const outHtml = path.join(DATA_DIR, 'formula-preview.html');
fs.writeFileSync(outHtml, html, 'utf8');

const png = path.join(DATA_DIR, 'formula-preview.png');
fs.rmSync(png, { force: true });
const edge = findEdge();
const url = 'file:///' + outHtml.replace(/\\/g, '/');
await new Promise((resolve) => {
  const p = spawn(edge, ['--headless=new', '--disable-gpu', '--no-first-run', '--hide-scrollbars', `--screenshot=${png}`, '--window-size=1100,900', '--virtual-time-budget=6000', url], { windowsHide: true });
  p.on('close', resolve);
  setTimeout(() => { try { p.kill(); } catch {} resolve(); }, 20000);
});
console.log('已生成：' + png);
