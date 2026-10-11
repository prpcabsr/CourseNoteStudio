// 验证公式上下标补全：视觉模型常把 ∮_L、∑_{k=1}^{n} 写丢花括号。
import { repairLatex, MATH_CLASS } from '../app/lib/latex.mjs';
import { mdToHtml } from '../app/lib/render.mjs';

// 先自检字符类：少一个字符就会把公式从中间切开
const NEEDED = ['\\', '-', '+', '=', '/', '^', '_', '{', '}', '(', ')', '[', ']', '*', '!', '.', ',', ':', ';', "'", '·', '×', '|', '²', '₁', 'ε', 'π', 'φ', 'ψ', '∑', '∮', '∈', '∞'];
const clsRe = new RegExp(`[${MATH_CLASS}]`);
const missing = NEEDED.filter((c) => !clsRe.test(c));
console.log(missing.length ? `✗ 字符类缺少：${missing.join(' ')}` : '✓ 字符类完整（反斜杠/连字符等都在）');

const CASES = [
  // 用户实际遇到的那条：∮_L f(z)dz = 2πi ∑_{k=1}^{n} Res_{z=bk} f(z)
  ['\\oint L f(z) dz = 2\\pi i \\sum k=1 n Res z=bk f(z)', '围道积分 + 求和 + 留数'],
  ['$$\\sum k=1 n a_k$$', '求和上下限'],
  ['$\\sum_{k=1} n a_k$', '求和缺上限'],
  ['$\\oint_C f(z)dz$', '本来就正确的不要改坏'],
  ['$\\oint f(z) dz$', '被积函数不能被当成路径'],
  ['$\\lim x\\to x0 f(x)$', '极限'],
  ['$\\int E\\cdot dl = -\\frac{d\\Phi}{dt}$', '普通积分不受影响'],
  ['$f(x)=x^2+1$', '无上下标的公式不受影响'],
  // 附录里出现的：中文开头 + 裸公式，之前会原样显示成「乱码」
  ['①无奇点：\\oint_C f(z)dz=0', '中文前面 + 裸公式'],
  ['②有一阶极点α：\\oint_C \\frac{f(z)}{z-\\alpha}dz=2\\pi i f(\\alpha)', '较长裸公式'],
  ['③有几阶极点α₁：\\oint_C \\frac{f(z)}{(z-\\alpha)^n}dz=\\frac{2\\pi i}{(n-1)!}\\phi^{(n-1)}(\\alpha)', '带上下标的裸公式'],
  ['四成: f(z)在C内', '函数调用会被排成公式，中文不受影响'],
  ['\\oint_C f(z)dz=0 表示解析', '公式后面还有中文'],
  // 用户第二次遇到的：没有反斜杠的裸公式（概览/学习目标里）
  ['取负一次幂项系数 C_{-1} 作为留数', '下标没有反斜杠'],
  ['并以 e^{1/z} 在 z=0 处为例说明', '指数没有反斜杠'],
  ['得到 n 阶极点的通用公式 Res = 1/(n-1)! · lim (z-b)^n f(z) 的 n-1 阶导数', '整条公式没有反斜杠'],
  ['当 n=1 时退化为单极点公式 Res = lim (z-b)f(z)', '带等号的短公式'],
  ['并进一步对 f=φ/ψ 型函数简化为 φ(b)/ψ\'(b)', '希腊字母分式'],
  ['通过 1/(e^z-1)、z e^z/(z-a)^3 等例题演示', '多个公式混在句子里'],
  ['已经写好的 $C_{-1}$ 与 e^{1/z} 混在一行', '一行里既有 $ 又有裸公式'],
  ['这次生成的笔记保存在 notes_final.json 里', '文件名不能被当成公式'],
  ['视频链接是 https://example.com/a=1 可以用', '网址不能被当成公式'],
  // 这一条是 KaTeX 真的报错的那种：绝对值竖线和 Unicode 上标漏在字符类外，公式被拆散
  ['5. 计算 ∮_{|z|=1} dz/(z²+2z+ε)，其中 0<ε<1。', '绝对值竖线 + Unicode 上标'],
  ['设 |z-z₀|<R 时级数收敛', 'Unicode 下标'],
  ['α₁、α₂ 是两根', 'Unicode 下标希腊字母'],
];

// 这些必须「原样不动」——之前 mergeAdjacentMath 写太猛，把行间公式 $$..$$ 也拆了
const NOCHANGE = [
  ['$$\\lim_{x \\to x_0} f(x) = f(x_0)$$ —— 函数 $f(x)$ 在 $x_0$ 处连续的定义，即极限值等于函数值。', '行间公式与行内公式混排'],
  ['$$|x^2 - x_0^2| = |x - x_0|\\,|x + x_0|$$ —— 证明 $f(x)=x^2$ 在 $x_0$ 处连续时的因式分解。', '第二条公式汇总'],
  ['$$\\sum_{k=1}^{n} a_k$$', '单纯的行间公式'],
];

let fail = 0;
if (missing.length) fail++;
for (const [src, name] of CASES) {
  const out = repairLatex(src);
  const changed = out !== src;
  console.log(`\n【${name}】`);
  console.log('  原：' + src);
  console.log('  后：' + out + (changed ? '   ← 已修正' : '   （未改动）'));
}

console.log('\n──────── 必须原样不动的情况 ────────');
for (const [src, name] of NOCHANGE) {
  const out = repairLatex(src);
  const ok = out === src;
  if (!ok) fail++;
  console.log(`${ok ? '✓' : '✗'} ${name}`);
  if (!ok) {
    console.log('   原：' + src);
    console.log('   后：' + out);
  }
}

// 渲染检查：确认修复后的公式能被 KaTeX 正常排版（不是当普通文字排）
const md = '$$\\oint L f(z)\\,dz = 2\\pi i \\sum k=1 n Res z=bk f(z)$$';
const html = mdToHtml(md);
const okKatex = html.includes('katex') && !html.includes('katex-error');
const hasSub = /class="mord[^"]*"[^>]*>L</.test(html) || html.includes('msupsub');
console.log('\nKaTeX 渲染：' + (okKatex ? '✓ 已排版为公式' : '✗ 排版异常'));
console.log('包含上下标结构（msupsub）：' + (html.includes('msupsub') ? '✓' : '✗'));
console.log('残留裸文本 "\\oint L"：' + (html.includes('\\oint L') ? '✗ 仍存在' : '✓ 已消除'));
if (!okKatex || !html.includes('msupsub') || html.includes('\\oint L')) fail++;

// 用户截图里的那段概览：确认渲染后不再出现裸的 C_{-1} / e^{1/z}
const overview =
  '取负一次幂项系数 C_{-1} 作为留数，并以 e^{1/z} 在 z=0 处为例说明。' +
  '得到 n 阶极点的通用公式 Res = 1/(n-1)! · lim (z-b)^n f(z)。';
const oh = mdToHtml(overview);
const bare = /C_\{-1\}|e\^\{1\/z\}/.test(oh.replace(/<[^>]+>/g, ''));
console.log('\n概览段落：' + (oh.includes('katex') ? '✓ 公式已排版' : '✗ 没有排版'));
console.log('残留裸文本 C_{-1} / e^{1/z}：' + (bare ? '✗ 仍存在' : '✓ 已消除'));
console.log('渲染成 KaTeX 的公式个数：' + (oh.match(/class="katex"/g) || []).length);
if (bare || !oh.includes('katex')) fail++;

process.exit(fail ? 1 : 0);
