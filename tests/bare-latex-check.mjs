// 检查成稿 HTML 里有没有「没被 $ 包住」的裸公式。
// 用法：node tests/bare-latex-check.mjs [项目id]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const PROJ_DIR = path.join(ROOT, 'data', 'projects');

/** 没有指定 id 时，自动挑一个「已经有成稿」的任务；一个都没有就直接跳过。 */
function pickProject() {
  if (process.argv[2]) return process.argv[2];
  if (!fs.existsSync(PROJ_DIR)) return null;
  const candidates = fs
    .readdirSync(PROJ_DIR)
    .filter((d) => fs.existsSync(path.join(PROJ_DIR, d, 'work', 'doc.json')))
    .sort();
  return candidates.pop() || null;
}
const id = pickProject();
if (!id) {
  console.log('· 还没有任何已生成的成稿，跳过（先跑一个任务再来）');
  process.exit(0);
}
const dir = path.join(PROJ_DIR, id, 'out');
const doc = JSON.parse(fs.readFileSync(path.join(PROJ_DIR, id, 'work', 'doc.json'), 'utf8'));
console.log(`检查任务：${id}`);

/** 把 Markdown 里的数学片段挖掉，再看剩下的文字里有没有 LaTeX 痕迹 */
function stripMath(md) {
  return String(md)
    .replace(/\$\$[\s\S]*?\$\$/g, ' ')
    .replace(/\$[^$\n]*\$/g, ' ');
}

const PATTERNS = [
  [/[A-Za-z0-9)\]}]\s*[\^_]\s*[\{A-Za-z0-9]/, '下标/上标裸露'],
  [/[A-Za-z0-9)\]}]\s*=\s*[A-Za-z0-9({\\-]/, '等号裸露'],
  [/\\[a-zA-Z]{2,}/, 'LaTeX 命令裸露'],
];

let bad = 0;
const fields = [
  ['概览', doc.overview],
  ['关键公式', doc.formulas],
  ['术语表', doc.glossary],
  ['自测题', doc.quiz],
  ...(doc.objectives || []).map((o, i) => [`学习目标${i + 1}`, o]),
  ...(doc.sections || []).flatMap((s, i) => [[`第${i + 1}节标题`, s.title], [`第${i + 1}节正文`, s.markdown || s.body]]),
];

for (const [name, text] of fields) {
  if (!text) continue;
  const plain = stripMath(text);
  for (const [re, why] of PATTERNS) {
    const m = plain.match(re);
    if (m) {
      bad++;
      console.log(`✗ ${name}：${why} → …${plain.slice(Math.max(0, m.index - 20), m.index + 30).replace(/\n/g, ' ')}…`);
      break;
    }
  }
}

// 同时看渲染出的 HTML：KaTeX 有没有报错
const htmlPath = path.join(dir, 'notes.html');
if (fs.existsSync(htmlPath)) {
  const h = fs.readFileSync(htmlPath, 'utf8');
  const katex = (h.match(/class="katex"/g) || []).length;
  const errs = (h.match(/katex-error/g) || []).length;
  console.log(`\n成稿 HTML：KaTeX 公式 ${katex} 处，排版报错 ${errs} 处`);
  if (errs) bad++;
}

console.log(bad ? `\n共发现 ${bad} 处问题` : '\n✓ 没有裸露的公式写法');
process.exit(bad ? 1 : 0);
