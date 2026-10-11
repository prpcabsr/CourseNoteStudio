// 模型 JSON 容错解析自测：LaTeX 反斜杠、控制字符歧义、围栏、裸换行、截断。
import { parseLlmJson, repairJsonEscapes } from '../app/lib/json.mjs';

const CASES = [
  ['普通 JSON', '{"a":1}', (o) => o.a === 1],
  ['带代码围栏', '```json\n{"a":2}\n```', (o) => o.a === 2],
  // 用户实际遇到的报错：\d 不是合法 JSON 转义
  ['LaTeX \\delta（非法转义）', '{"more":"开区间 $(x_0-\\delta, x_0+\\delta)$"}', (o) => o.more.includes('\\delta')],
  // \t \n \b \f \r 既是合法转义又是 LaTeX 开头，靠后一个字符区分
  ['LaTeX \\to（与制表符歧义）', '{"t":"$\\lim_{x \\to 0}$"}', (o) => o.t.includes('\\to') && !o.t.includes('\t')],
  ['LaTeX \\nabla（与换行歧义）', '{"t":"$\\nabla f$"}', (o) => o.t.includes('\\nabla') && !o.t.includes('\n')],
  ['LaTeX \\frac \\oint \\rho \\beta', '{"t":"$\\frac{1}{2}$ $\\oint_C$ $\\rho$ $\\beta$"}', (o) => ['\\frac', '\\oint', '\\rho', '\\beta'].every((k) => o.t.includes(k))],
  ['真正的换行转义要保留', '{"t":"第一行\\n第二行"}', (o) => o.t.includes('\n') && !o.t.includes('\\n')],
  ['\\n 后面跟普通字母不能误判', '{"t":"第一行\\nSecond line"}', (o) => o.t.includes('\n') && o.t.includes('Second')],
  ['字符串里裸换行', '{"t":"第一行\n第二行"}', (o) => o.t.includes('第一行')],
  ['前后有解释文字', '好的，结果如下：\n{"a":3}\n以上。', (o) => o.a === 3],
  ['引号与反斜杠转义不能改坏', '{"t":"引号\\" 反斜杠\\\\ 结尾"}', (o) => o.t.includes('"') && o.t.includes('\\') && o.t.endsWith('结尾')],
  ['\\u 转义要保留', '{"t":"\\u4e2d\\u6587"}', (o) => o.t === '中文'],
  ['数组里的 LaTeX', '{"items":[{"more":"$\\alpha\\beta\\gamma$"}]}', (o) => o.items[0].more.includes('\\alpha')],
];

let bad = 0;
for (const [name, src, check] of CASES) {
  try {
    const o = parseLlmJson(src, '测试');
    const ok = check(o);
    if (!ok) {
      bad++;
      console.log(`✗ ${name} → 解析结果不符合预期：${JSON.stringify(o).slice(0, 90)}`);
    } else {
      console.log(`✓ ${name}`);
    }
  } catch (e) {
    bad++;
    console.log(`✗ ${name} → 抛错：${e.message}`);
  }
}

// 单独验修补函数：合法的别动，非法的补上
const fixed = repairJsonEscapes('{"a":"\\d \\n \\to \\u4e2d \\" \\\\"}');
const checks = [
  ['非法 \\d 补成 \\\\d', fixed.includes('\\\\d')],
  ['换行转义 \\n 保留', /\\n/.test(fixed)],
  ['LaTeX \\to 补成 \\\\to', fixed.includes('\\\\to')],
  ['\\u4e2d 保留', fixed.includes('\\u4e2d')],
  ['引号转义保留', fixed.includes('\\"')],
  ['反斜杠转义保留', fixed.includes('\\\\"')],
];
for (const [n, ok] of checks) {
  if (!ok) bad++;
  console.log(`${ok ? '✓' : '✗'} ${n}`);
}

console.log(bad ? `\n✗ ${bad} 项失败` : '\n✓ 全部通过');
process.exit(bad ? 1 : 0);
