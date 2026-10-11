// 从 PDF 的文字层里看公式到底是「排好版的上下标」还是「字面的 LaTeX 源码」。
// 用法：node tests/pdf-text-check.mjs [项目id] [页码从0开始]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const id = process.argv[2] || fs.readdirSync(path.join(ROOT, 'data', 'projects')).sort().pop();
const page = Number(process.argv[3] || 0);
const dir = path.join(ROOT, 'data', 'projects', id, 'out');
const pdf = path.join(dir, fs.readdirSync(dir).find((f) => f.endsWith('.pdf')));

const mupdf = await import('mupdf');
const doc = mupdf.Document.openDocument(fs.readFileSync(pdf), 'application/pdf');
const text = doc.loadPage(page).toStructuredText().asText();

const i = text.indexOf('本讲概览');
const seg = i >= 0 ? text.slice(i, i + 800) : text.slice(0, 800);
console.log('--- PDF 文字层（第 ' + (page + 1) + ' 页）---');
console.log(seg);
console.log('--- 客观判定 ---');
const marks = { 下划线_: seg.includes('_'), 花括号: /[{}]/.test(seg), 脱字符: seg.includes('^'), 反斜杠: seg.includes('\\') };
for (const [k, v] of Object.entries(marks)) console.log(`  ${v ? '✗ 出现' : '✓ 没有'}字面「${k}」`);
const bad = Object.values(marks).some(Boolean);
console.log(bad ? '\n✗ 文字层里还有 LaTeX 源码（说明没排版）' : '\n✓ 文字层里没有 LaTeX 源码（说明公式已排版，上下标是真实排版）');
process.exit(bad ? 1 : 0);
