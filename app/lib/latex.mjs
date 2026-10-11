// LaTeX 规范化：模型（视觉识别 / 整理成文）经常把公式写成「裸文本」，
// 例如 ∮_L 写成 "\oint L"、C_{-1} 写成 "C_{-1}"、e^{1/z} 写成 "e^{1/z}"，
// 没有用 $...$ 包起来，KaTeX 就会把这些当成普通字符原样排出来（看起来像乱码）。
//
// 这里做确定性的补全，分两类：
//   1) 带反斜杠命令的公式（\oint_C ... \frac{..}{..}）
//   2) 不带反斜杠、但有上下标/等号/分式的数学串（C_{-1}、e^{1/z}、z=0、φ(b)/ψ'(b)）
// 只处理「模式明确」的情况，不猜内容；可以重复执行（幂等）。
//
// 三处调用：识别写盘时、整理成文前、生成 HTML 时。

import { createRequire } from 'node:module';

const RULES = [
  // \sum k=1 n  →  \sum_{k=1}^{n}
  [/\\sum\s*([A-Za-z])\s*=\s*([0-9A-Za-z]+)\s+([0-9A-Za-z]+)/g, '\\sum_{$1=$2}^{$3}'],
  // \sum_{k=1} n  →  \sum_{k=1}^{n}
  [/\\sum_\{([^{}]*)\}\s+([0-9A-Za-z])(?![0-9A-Za-z])/g, '\\sum_{$1}^{$2}'],
  // \prod k=1 n → \prod_{k=1}^{n}
  [/\\prod\s*([A-Za-z])\s*=\s*([0-9A-Za-z]+)\s+([0-9A-Za-z]+)/g, '\\prod_{$1=$2}^{$3}'],
  // 围道/重积分后面紧跟一个孤立大写字母 = 积分路径：\oint L → \oint_{L}
  [/\\(oint|iint|iiint|int)\s*([A-Z])(?![A-Za-z0-9(\\])/g, '\\$1_{$2}'],
  // \lim x\to x0 → \lim_{x \to x0}
  [/\\lim\s+([A-Za-z])\s*\\to\s*([0-9A-Za-z]+)/g, '\\lim_{$1 \\to $2}'],
  // \operatorname{Res} z=bk → \operatorname{Res}_{z=bk}
  [/(?:\\operatorname\{Res\}|\\mathrm\{Res\}|\\Res)\s*([A-Za-z])\s*=\s*([0-9A-Za-z]+)/g, '\\operatorname{Res}_{$1=$2}'],
  // 留数：Res z=bk → \operatorname{Res}_{z=bk}
  [/(?<![A-Za-z\\])Res\s*([A-Za-z])\s*=\s*([0-9A-Za-z]+)/g, '\\operatorname{Res}_{$1=$2}'],
];

const CJK = /[\u3000-\u303f\u4e00-\u9fff\uff00-\uffef]/;

// 公式里允许出现的字符（不含中文与全角标点，这样公式串遇到中文就自然断开）。
// 注意：字符类里「反斜杠、脱字符、花括号、中括号、连字符」都必须转义，缺一个就会
// 把公式从中间切开（漏过 \ 和 -，也漏过 | 和 ²，导致 $\oint_{|z|=1}$ 被拆散）。
const MATH_CLASS =
  'A-Za-z0-9_' +
  '\\^' + // ^
  '\\{\\}' + // { }
  '\\(\\)' + // ( )
  '\\[\\]' + // [ ]
  '\\\\' + // 反斜杠
  '\\-+*/=!.,:;<>' + // 连字符必须转义
  '|' + // 绝对值、\oint_{|z|=1}
  "'′″·×÷±∓−" +
  '∑∏∫∮√∂∞→⇒⇔°' +
  '∈∉⊂⊆∪∩∀∃≡≅∝∠⊥∥∅' +
  'αβγδεζηθικλμνξπρστυφχψωΓΔΘΛΞΠΣΦΨΩ' +
  'ℝℂℕℤℚ' +
  '⁰¹²³⁴⁵⁶⁷⁸⁹⁺⁻⁼⁽⁾ⁿⁱ' + // 上标
  '₀₁₂₃₄₅₆₇₈₉₊₋₌₍₎ₙₖₐₑₓᵢⱼ' + // 下标
  '≈≠≤≥';
const RUN_RE = new RegExp(`[${MATH_CLASS}](?:[${MATH_CLASS} ]*[${MATH_CLASS}])?`, 'g');

// 视觉模型常把黑板上的上标下标直接写成 Unicode 字符（z²、α₁），转成 LaTeX 更稳
const SUP = { '⁰': '0', '¹': '1', '²': '2', '³': '3', '⁴': '4', '⁵': '5', '⁶': '6', '⁷': '7', '⁸': '8', '⁹': '9', '⁺': '+', '⁻': '-', '⁼': '=', '⁽': '(', '⁾': ')', 'ⁿ': 'n', 'ⁱ': 'i' };
const SUB = { '₀': '0', '₁': '1', '₂': '2', '₃': '3', '₄': '4', '₅': '5', '₆': '6', '₇': '7', '₈': '8', '₉': '9', '₊': '+', '₋': '-', '₌': '=', '₍': '(', '₎': ')', 'ₙ': 'n', 'ₖ': 'k', 'ₐ': 'a', 'ₑ': 'e', 'ₓ': 'x', 'ᵢ': 'i', 'ⱼ': 'j' };
const SUP_RE = new RegExp(`[${Object.keys(SUP).join('')}]+`, 'g');
const SUB_RE = new RegExp(`[${Object.keys(SUB).join('')}]+`, 'g');

function normalizeCommandsInner(s) {
  return s
    .replace(SUP_RE, (m) => '^{' + [...m].map((c) => SUP[c]).join('') + '}')
    .replace(SUB_RE, (m) => '_{' + [...m].map((c) => SUB[c]).join('') + '}')
    .replace(/∆/g, '\\Delta') // U+2206 与 Δ 不是同一个字符，KaTeX 只认前者不认它
    .replace(/∇/g, '\\nabla')
    .replace(/(?<![\\A-Za-z{])lim(?![A-Za-z}])/g, '\\lim')
    .replace(/(?<![\\A-Za-z{])Res(?![A-Za-z}])/g, '\\operatorname{Res}')
    .replace(/(?<![\\A-Za-z{])(sin|cos|tan|cot|ln|log|exp|max|min|sup|inf|det|dim)(?![A-Za-z}])/g, '\\$1');
}

/** 把公式里人写的 lim / Res / sin 之类转成真正的 LaTeX 命令（只用于我们自己包起来的公式）。 */
function normalizeCommands(s) {
  const warn = console.warn;
  console.warn = () => {}; // KaTeX 遇到没有字形的字符会刷警告，这里静音
  try {
    return normalizeCommandsInner(s);
  } finally {
    console.warn = warn;
  }
}

/** 判断一小段文本是不是「数学」。宁可少判，也不要把正常文字包进公式。 */
function looksLikeMath(s) {
  if (!s || s.length < 2) return false;
  if (/^\d+(\.\d+)?$/.test(s)) return false; // 纯数字
  if (/https?:|\/\/|@/.test(s)) return false; // 链接、邮箱
  if (/\.(mjs|js|json|mp4|mkv|mov|png|jpe?g|txt|md|bat|exe|pdf|html?|yaml)\b/i.test(s)) return false; // 文件名
  if (/\\[a-zA-Z]/.test(s)) return true; // 有反斜杠命令
  if (/[∫∮∑∏√∂∞]/.test(s)) return true; // 数学符号
  if (new RegExp('[\\p{L}\\p{N})\\]}]\\s*[\\^_]\\s*\\{', 'u').test(s)) return true; // x^{..} / x_{..}
  // 短基底的上下标：x_0、a_n、e^z（"notes_v2" 这种长基底不算）
  if (new RegExp('([\\p{L}\\p{N})\\]}]{1,3})\\s*[\\^_]\\s*[\\p{L}\\p{N}]', 'u').test(s)) return true;
  if (/[\p{L}\p{N})\]}] *=[=]? *[\p{L}\p{N}(\{\\-]/u.test(s)) return true; // 等号
  if (/[\p{L}\p{N})\]}] *[<>≤≥] *[\p{L}\p{N}(\{\\-]/u.test(s)) return true; // 不等号、小于大于
  if (/[\p{L}\p{N})\]}] *\/ *[\p{L}\p{N}(\{\\-]/u.test(s)) return true; // 分式斜杠
  if (/[⁰¹²³⁴⁵⁶⁷⁸⁹₀₁₂₃₄₅₆₇₈₉ⁿₖₐₑₓᵢⱼ]/.test(s)) return true; // Unicode 上下标：z²、α₁
  // 简单函数调用：f(z)、φ(b)、x(t)——只为和已经排成公式的地方保持字体一致
  if (/^[\p{L}]\s?\([^()]{1,10}\)$/u.test(s)) return true;
  return false;
}

/** 给一段「不含 $ 的普通文字」里的裸公式补上 $...$。 */
function wrapPlain(seg) {
  return seg.replace(RUN_RE, (run) => {
    if (!looksLikeMath(run)) return run;
    return '$' + normalizeCommands(run.trim()) + '$';
  });
}

/**
 * 行内「裸公式」补上 $...$。
 * 只处理 $...$ 之外的部分，因此可以重复调用。
 */
export function wrapBareLatex(line) {
  if (!line.includes('$')) return wrapPlain(line);
  // 按已有的 $...$ / $$...$$ 切片，只处理公式之外的文字
  const parts = line.split(/(\$\$[^$]*\$\$|\$[^$]*\$)/g);
  return parts.map((p) => (/^\$\$[^$]*\$\$$/.test(p) || /^\$[^$]*\$$/.test(p) ? p : wrapPlain(p))).join('');
}

/**
 * 把一行里被拆开的相邻行内公式合并回一条：
 *   「$\lim d$$^{2}/dz^{2}$$(z e^z)$」→「$\lim d^{2}/dz^{2}(z e^z)$」
 * 这种 `$A$$B$` 会被 Markdown 当成行间公式的定界符，排出来就散了。
 *
 * 注意必须按「公式 — 文字 — 公式」分词后再合并：
 * 直接写正则会误伤正常的 `$$...$$` 行间公式（那种不能合并）。
 */
function mergeAdjacentMath(line) {
  const re = /\$\$[\s\S]*?\$\$|\$[^$\n]*\$/g;
  const parts = [];
  let last = 0;
  let m;
  while ((m = re.exec(line))) {
    if (m.index > last) parts.push({ t: line.slice(last, m.index) });
    parts.push({ m: m[0] });
    last = m.index + m[0].length;
  }
  if (last < line.length) parts.push({ t: line.slice(last) });

  const isInline = (s) => !!s && s.length > 2 && s.startsWith('$') && s.endsWith('$') && !s.startsWith('$$');
  const out = [];
  for (const p of parts) {
    const prev = out[out.length - 1];
    if (p.m && prev && prev.m && isInline(prev.m) && isInline(p.m)) {
      // 中间没有文字 → 是同一段公式被 $ 切开了，拼回去
      prev.m = '$' + prev.m.slice(1, -1) + p.m.slice(1, -1) + '$';
    } else {
      out.push({ ...p });
    }
  }
  return out.map((p) => (p.m !== undefined ? p.m : p.t)).join('');
}

/** 对一段文本里的公式做规范化。 */
export function repairLatex(input) {
  if (!input) return '';
  let out = String(input);
  for (const [re, to] of RULES) out = out.replace(re, to);
  out = out
    .split('\n')
    .map((raw) => {
      const line = raw.includes('$') ? mergeAdjacentMath(raw) : raw;
      const t = line.trim();
      // 整行就是一条公式且不含中文：作为行间公式
      if (!t.includes('$') && looksLikeMath(t) && !CJK.test(t) && t.length > 3) {
        return '$$' + normalizeCommands(t) + '$$';
      }
      // 这一行里已有的 $...$ 如果 KaTeX 解析不了（例如之前某次处理把 $ 插错了位置），
      // 就把整行的 $ 去掉重新包一遍——自愈，避免错误越滚越大。
      if (line.includes('$') && hasBrokenMath(line)) {
        const keep = [];
        const masked = line.replace(/\$\$[\s\S]*?\$\$/g, (m) => {
          if (!parses(m.slice(2, -2))) return m;
          keep.push(m);
          return `\u0000${keep.length - 1}\u0000`;
        });
        const healed = wrapBareLatex(masked.replace(/\$/g, ''));
        return healed.replace(/\u0000(\d+)\u0000/g, (_, i) => keep[Number(i)] ?? '');
      }
      return wrapBareLatex(line);
    })
    .join('\n');
  return out;
}

let katexLib;
let katexTried = false;
function getKatex() {
  if (!katexTried) {
    katexTried = true;
    try {
      katexLib = createRequire(import.meta.url)('katex');
    } catch {
      katexLib = null;
    }
  }
  return katexLib;
}

function parses(tex) {
  const k = getKatex();
  if (!k) return true; // 没装 katex 就不做这项检查
  const warn = console.warn;
  console.warn = () => {};
  try {
    k.renderToString(tex, { throwOnError: true, strict: false });
    return true;
  } catch {
    return false;
  } finally {
    console.warn = warn;
  }
}

function hasBrokenMath(line) {
  const k = getKatex();
  if (!k) return false;
  for (const m of line.matchAll(/\$\$([\s\S]*?)\$\$|\$([^$\n]*)\$/g)) {
    if (!parses(m[1] ?? m[2])) return true;
  }
  return false;
}

export { RULES, MATH_CLASS };
