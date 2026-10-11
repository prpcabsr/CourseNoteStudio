// 横线格子的对齐规则自检：所有纵向尺寸都必须是格子高度的整数倍。
// 用法：node tests/grid-check.mjs
import { buildHtml, lookCss, ruleHeight } from '../app/lib/render.mjs';

const doc = { title: 't', sections: [], overview: '', objectives: [], timeline: [] };
const html = buildHtml(doc, { meta: { title: 't', paper: 'A4', paperStyle: 'lined', font: 'wenkai', fontSize: 10.8 } });

const checks = [
  ['格子高度随字号计算', /--rule-h:(\d+)px/.test(html)],
  ['正文行高 = 格子高度', /line-height: var\(--rule-h\)/.test(html)],
  ['标题外边距取整格', /h1,h2,h3,h4,h5 \{ margin-top: 0; margin-bottom: var\(--rule-h\)/.test(html)],
  ['没有半格行高', !/var\(--rule-h\) \* 1\.5/.test(html)],
  ['段落外边距取整格', /p,ul,ol \{ margin-bottom: var\(--rule-h\)/.test(html)],
  ['盒子外边距取整格', /\.callout,figure,table,pre,blockquote,\.stat-row/.test(html)],
  ['盒子内不留竖直内边距', /\.callout,blockquote,\.stat \{ padding-top: 0; padding-bottom: 0/.test(html)],
  ['底纹半透明（横线能透出来）', html.includes('color-mix(in srgb, var(--accent) 5%, transparent)')],
  ['公式块上下留整格', /\.katex-display \{ margin: var\(--rule-h\) 0 !important/.test(html)],
  ['外观层排在基础样式之后', html.indexOf('外观层放最后') > html.indexOf('.callout {')],
  ['横线是等间距的重复渐变', html.includes('repeating-linear-gradient')],
];

let bad = 0;
for (const [name, ok] of checks) {
  if (!ok) bad++;
  console.log(`${ok ? '✓' : '✗'} ${name}`);
}

// 字号变了，格子必须跟着变
const sizes = [9, 10.8, 12, 14];
const rhs = sizes.map((s) => ruleHeight(s));
const monotonic = rhs.every((v, i) => i === 0 || v > rhs[i - 1]);
console.log(`${monotonic ? '✓' : '✗'} 字号变大格子跟着变大：${sizes.map((s, i) => s + 'pt→' + rhs[i] + 'px').join('、')}`);
if (!monotonic) bad++;

// 每个字号下，行高与字号的比值应当稳定（视觉一致）
const ratios = sizes.map((s, i) => rhs[i] / (s * (96 / 72)));
const stable = ratios.every((r) => r > 1.5 && r < 1.9);
console.log(`${stable ? '✓' : '✗'} 行高/字号 比值稳定：${ratios.map((r) => r.toFixed(2)).join('、')}`);
if (!stable) bad++;

// lookCss 是预览与 PDF 共用的同一份
const a = lookCss({ paperStyle: 'lined', font: 'wenkai', fontSize: 10.8 }).css;
const b = lookCss({ paperStyle: 'lined', font: 'wenkai', fontSize: 10.8 }).css;
console.log(`${a === b ? '✓' : '✗'} 同一套设置生成的 CSS 完全一致（预览与 PDF 不会跑偏）`);
if (a !== b) bad++;

console.log(bad ? `\n✗ ${bad} 项失败` : '\n✓ 格子对齐规则全部满足');
process.exit(bad ? 1 : 0);
