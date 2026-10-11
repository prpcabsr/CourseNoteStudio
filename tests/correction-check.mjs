// 老师更正板书的检测：既要抓得准，也不能把正常讲课当成更正。
// 用法：node tests/correction-check.mjs
import { findCorrections, correctionsInRange, renderCorrections } from '../app/lib/corrections.mjs';
import { buildWindows } from '../app/lib/fusion.mjs';

const seg = (start, text) => ({ start, end: start + 4, text });

// 应该被识别为「更正」的
const yes = [
  ['刚才这个留数公式我写错了，应该是 Res = lim(z-b)f(z)', '承认写错'],
  ['不好意思，这里更正一下，分母应该是 z²+1 不是 z²-1', '明确更正'],
  ['哎呀笔误，这个系数不是 2 而是 3', '口误/笔误'],
  ['这块擦掉重写，我们把顺序换一下', '擦掉重写'],
  ['不对，应该是先求极限再判断连续性', '否定后给出正确'],
  ['我漏写了一个条件：f(z) 在 z₀ 的邻域内要有定义', '补写/漏写'],
];

// 正常讲课，不该被误判
const no = [
  ['这个错误在考试里很常见，大家注意', ''],
  ['我们来看一个改错题', ''],
  ['这不是极点，而是本性奇点，两者区别很大', ''],
  ['错项相消之后剩下的就是主部', ''],
  ['这个公式很重要，记下来', ''],
  ['极限存在且等于函数值，就称为连续', ''],
];

let bad = 0;
for (const [text, label] of yes) {
  const got = findCorrections([seg(60, text)]);
  const ok = got.length === 1;
  if (!ok) bad++;
  console.log(`${ok ? '✓' : '✗'} 识别到更正（${label}）：${text.slice(0, 24)}…`);
}
for (const [text] of no) {
  const got = findCorrections([seg(60, text)]);
  const ok = got.length === 0;
  if (!ok) bad++;
  console.log(`${ok ? '✓' : '✗'} 不误判：${text.slice(0, 24)}…`);
}

// 连续几句合并成一条（同一处更正不要说成好几条）
const merged = findCorrections([
  seg(100, '我写错了'),
  seg(103, '应该是 z²+1'),
  seg(106, '刚才那个符号也反了'),
]);
const mergeOk = merged.length === 1;
if (!mergeOk) bad++;
console.log(`${mergeOk ? '✓' : '✗'} 10 秒内的连续更正合并为一条（得到 ${merged.length} 条）`);

// 窗口切分：更正清单必须下发到**每一个**窗口。
// 老师可能讲了 10 分钟才发现写错，写前面那一段时如果看不到更正，
// 就会把作废的写法当成结论写死。
const corrections = findCorrections([seg(600, '刚才写错了，应该是 3')]);
const windows = buildWindows({
  transcript: { segments: [seg(60, '先写一个公式'), seg(600, '刚才写错了，应该是 3'), seg(700, '继续讲')] },
  snapshots: [],
  duration: 900,
  windowMinutes: 5, // 0-300、300-600、600-900
  corrections,
});
const counts = windows.map((w) => (w.corrections || []).length);
const windowOk = counts.every((c) => c === corrections.length);
if (!windowOk) bad++;
console.log(
  `${windowOk ? '✓' : '✗'} 更正清单下发到每个窗口（写前面内容时也知道后面被更正了）：${counts.join('、')}`,
);

// 渲染成提示词
const rendered = renderCorrections(corrections);
const renderOk =
  rendered.includes('老师在课堂上更正过的地方') &&
  rendered.includes('10:00') &&
  rendered.includes('已作废');
if (!renderOk) bad++;
console.log(`${renderOk ? '✓' : '✗'} 能渲染进提示词（含时间点与作废说明）`);

// 范围筛选
const inRange = correctionsInRange(corrections, 0, 700).length === 1 && correctionsInRange(corrections, 700, 900).length === 0;
if (!inRange) bad++;
console.log(`${inRange ? '✓' : '✗'} 按时间范围筛选正确`);

console.log(bad ? `\n✗ ${bad} 项失败` : '\n✓ 更正检测全部通过');
process.exit(bad ? 1 : 0);
