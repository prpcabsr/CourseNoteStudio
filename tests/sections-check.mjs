// 直接问正在运行的服务：笔记章节返回的 HTML 里还有没有「没排版」的公式。
// 用法：node tests/sections-check.mjs [项目id] [端口]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const id = process.argv[2] || fs.readdirSync(path.join(ROOT, 'data', 'projects')).sort().pop();
const port = process.argv[3] || 7788;

const res = await fetch(`http://127.0.0.1:${port}/api/projects/${id}/sections`);
if (!res.ok) {
  console.log(`服务返回 ${res.status}`);
  process.exit(1);
}
const data = await res.json();

let bad = 0;
const fields = [
  ['本讲概览', data.overview],
  ...(data.objectives || []).map((o, i) => [`学习目标${i + 1}`, o]),
  ...(data.sections || []).map((s, i) => [`第${i + 1}节标题`, s.title]),
  ...(data.sections || []).map((s, i) => [`第${i + 1}节正文`, s.html]),
  ['关键公式', data.formulas],
  ['术语表', data.glossary],
  ['自测题', data.quiz],
];

for (const [name, html] of fields) {
  if (!html) continue;
  // 去掉 KaTeX 渲染出来的部分，剩下的文字里不该再出现 LaTeX 记号
  const plain = String(html)
    .replace(/<span class="katex[\s\S]*?<\/span><\/span><\/span>/g, ' MATH ')
    .replace(/<[^>]+>/g, ' ');
  const m = plain.match(/[A-Za-z0-9)\]}]\s*_\{|[A-Za-z0-9)\]}]\s*\^\{|\$[^$]{2,}\$|\\[a-zA-Z]{2,}/);
  if (m) {
    bad++;
    console.log(`✗ ${name}：…${plain.slice(Math.max(0, m.index - 30), m.index + 40).replace(/\s+/g, ' ')}…`);
  }
}

const html = JSON.stringify(data);
const katexCount = (html.match(/class=\\?"katex\\?"/g) || []).length;
console.log(`笔记章节接口（端口 ${port}）：章节 ${(data.sections || []).length} 个，板书时间线 ${(data.board || []).length} 条，已排版公式 ${katexCount} 处`);
console.log(bad ? `\n✗ 还有 ${bad} 处没排版` : '\n✓ 界面上的公式全部已排版');
process.exit(bad ? 1 : 0);
