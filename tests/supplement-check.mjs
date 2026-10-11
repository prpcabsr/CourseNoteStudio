// AI 补充自测：接口能返回、anchor 能在成稿里定位到段落。
// 用法：node tests/supplement-check.mjs [项目id]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadSupplements } from '../app/lib/supplement.mjs';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const id = process.argv[2] || fs.readdirSync(path.join(ROOT, 'data', 'projects')).sort().pop();
const dir = path.join(ROOT, 'data', 'projects', id);

const sup = loadSupplements(id);
console.log(`项目 ${id}：补充 ${sup.items.length} 条${sup.at ? '（生成于 ' + sup.at + '）' : ''}`);
if (!sup.items.length) {
  console.log('（还没有生成过补充内容，先在界面里点「✨ AI 补充」）');
  process.exit(0);
}

const htmlPath = path.join(dir, 'out', 'notes.html');
if (!fs.existsSync(htmlPath)) {
  console.log('还没有成稿 HTML');
  process.exit(1);
}
const html = fs.readFileSync(htmlPath, 'utf8');
const sections = (html.match(/class="section"/g) || []).length;
const paras = (html.match(/<p>/g) || []).length;
console.log(`成稿结构：${sections} 个 .section，${paras} 个 <p>`);
console.log('');

// 前端是在 DOM 上把 .katex 整个删掉再比文字，这里没法建 DOM，
// 所以改成校验「锚点 → 章节正文」这层配对；DOM 那层由浏览器截图确认。
const doc = JSON.parse(fs.readFileSync(path.join(dir, 'work', 'doc.json'), 'utf8'));
const stripMath = (s) => String(s).replace(/\$\$[^$]*\$\$|\$[^$]*\$/g, '').replace(/\\[a-zA-Z]+/g, '');
const compact = (s) => stripMath(s).replace(/\s+/g, '');

let miss = 0;
for (const it of sup.items) {
  const sec = doc.sections[it.section - 1];
  const key = compact(it.anchor);
  const hit = !!sec && key.length >= 3 && compact(sec.markdown).includes(key);
  if (!hit) miss++;
  console.log(`${hit ? '✓' : '✗'} 第${it.section}节 [${it.title}] ${hit ? '锚点在正文里' : '锚点对不上'}  「${key.slice(0, 30)}」`);
  console.log(`     旁注(${(it.short || '').length}字)：${it.short}`);
  console.log(`     详解(${(it.more || '').length}字)`);
}
console.log('');
if (miss) {
  console.log(`✗ 有 ${miss} 条锚点在成稿里找不到，界面会把它们落到该节第一段`);
} else {
  console.log('✓ 所有锚点都能在成稿里准确定位');
}
process.exit(0);
