// 解析模型吐出来的 JSON。
//
// 为什么不能直接 JSON.parse：模型写 LaTeX 时会把反斜杠原样放进来，例如
//   "邻域指以 $x_0$ 为中心的开区间 $(x_0-\delta, x_0+\delta)$"
// 其中的 \d 不是合法 JSON 转义，JSON.parse 直接抛
// 「Bad escaped character in JSON at position ...」。
//
// 麻烦的是 \b \f \n \r \t 既是合法 JSON 转义、又是 LaTeX 命令的开头
// （\beta \frac \nabla \rho \to），所以要看后一个字符来决定：
//   \to     → 反斜杠 + to   （LaTeX）
//   \n\n    → 换行          （JSON 转义）
//   \nabla  → 反斜杠 + nabla（LaTeX）

const CONTROL = 'bfnrt';

// \b \f \n \r \t 既是合法 JSON 转义、又是 LaTeX 命令的开头。
// 用常见命令表来区分：\nabla 是 LaTeX，\nSecond 是换行。
const CMD_PREFIX = {
  b: ['beta', 'big', 'begin', 'bar', 'bmod', 'because', 'bmatrix'],
  f: ['frac', 'forall', 'flat', 'frown', 'footnotesize'],
  n: ['nabla', 'neq', 'notin', 'newline', 'nonumber', 'nleq', 'ngeq', 'not'],
  r: ['rho', 'rightarrow', 'right', 'rm', 'real', 'rfloor', 'rceil'],
  t: ['to', 'times', 'theta', 'tau', 'tan', 'tilde', 'text', 'top', 'tfrac', 'therefore'],
};

function isLatexCommand(next, rest) {
  const list = CMD_PREFIX[next];
  return !!list && list.some((cmd) => rest.startsWith(cmd));
}

/** 逐字符扫描，把非法的反斜杠转义补成字面反斜杠。 */
export function repairJsonEscapes(s) {
  const src = String(s);
  let out = '';
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (ch !== '\\') {
      out += ch;
      continue;
    }
    const next = src[i + 1];
    if (next === undefined) {
      out += '\\\\';
      continue;
    }
    // 无歧义的合法转义，原样保留
    if (next === '"' || next === '\\' || next === '/') {
      out += ch + next;
      i++;
      continue;
    }
    if (next === 'u' && /^[0-9a-fA-F]{4}$/.test(src.slice(i + 2, i + 6))) {
      out += src.slice(i, i + 6);
      i += 5;
      continue;
    }
    // 有歧义的控制字符：后面接的是已知 LaTeX 命令才算公式，否则按转义处理
    if (CONTROL.includes(next)) {
      if (isLatexCommand(next, src.slice(i + 1))) {
        out += '\\\\' + next;
        i++;
        continue;
      }
      out += ch + next;
      i++;
      continue;
    }
    // 其余（\d \oint \lim \alpha…）都是非法转义，补成字面反斜杠
    out += '\\\\';
  }
  return out;
}

/** 把字符串内部裸写的控制字符（模型常常直接换行）转成合法转义。 */
export function escapeRawControlsInStrings(s) {
  const src = String(s);
  let out = '';
  let inStr = false;
  let esc = false;
  for (const ch of src) {
    if (esc) {
      out += ch;
      esc = false;
      continue;
    }
    if (ch === '\\') {
      out += ch;
      esc = true;
      continue;
    }
    if (ch === '"') {
      inStr = !inStr;
      out += ch;
      continue;
    }
    if (inStr && ch < ' ') {
      out += ch === '\n' ? '\\n' : ch === '\t' ? '\\t' : ch === '\r' ? '\\r' : '\\u' + ch.charCodeAt(0).toString(16).padStart(4, '0');
      continue;
    }
    out += ch;
  }
  return out;
}

/** 去掉 ```json 围栏。 */
function stripFence(text) {
  return String(text)
    .replace(/^\s*```(?:json)?\s*/i, '')
    .replace(/\s*```\s*$/, '')
    .trim();
}

/**
 * 解析模型返回的 JSON 对象。
 * @param {string} text 模型输出
 * @param {string} what 出错时用于提示的名字
 */
export function parseLlmJson(text, what = '模型输出') {
  const t = stripFence(text);
  const brace = () => {
    const m = t.match(/\{[\s\S]*\}/);
    return m ? m[0] : null;
  };
  const attempts = [
    // 修补版本放最前面：扫描器只改「肯定是 LaTeX 命令」和「肯定非法」的地方，
    // 不会比原样解析更差；而原样解析会把 \nabla 悄悄吃成换行。
    () => JSON.parse(repairJsonEscapes(escapeRawControlsInStrings(t))),
    () => JSON.parse(repairJsonEscapes(t)),
    () => JSON.parse(escapeRawControlsInStrings(t)),
    () => JSON.parse(t),
    () => {
      const b = brace();
      if (!b) throw new Error('没有找到 JSON 对象');
      return JSON.parse(repairJsonEscapes(escapeRawControlsInStrings(b)));
    },
  ];
  let last;
  for (const fn of attempts) {
    try {
      const v = fn();
      if (v && typeof v === 'object') return v;
    } catch (e) {
      last = e;
    }
  }
  throw new Error(`${what}不是合法 JSON：${last ? last.message : '解析失败'}`);
}
