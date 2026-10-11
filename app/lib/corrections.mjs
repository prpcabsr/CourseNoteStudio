// 老师在课堂上更正板书的情况。
//
// 为什么需要单独处理：
//   板书是按「一代一代」保留的 —— 老师写错、过一会儿擦掉重写，那一代错误板书
//   仍然会被完整保留（这是为了「不丢内容」）。于是整理笔记时，错误版本和更正后的
//   版本会同时出现在材料里。如果模型不加判断，笔记里就会留着已经作废的写法。
//
// 这个模块只做一件确定性的事：从讲稿里找出老师明确更正过的地方，
// 交给整理笔记的模型，让它在这些位置只保留最终版本、并标注「此处更正过」。

/** 更正信号。用词都比较明确，避免把「这个错误很常见」之类当成更正。 */
const CUES = [
  { re: /(写|说|讲|算|看|记|抄|弄|搞|标|画|推)错/, label: '承认前面写错' },
  { re: /(更正|订正|纠正|勘误)/, label: '明确更正' },
  { re: /(笔误|口误|弄错|搞错|搞混|弄混)/, label: '口误/笔误' },
  { re: /(擦掉|划掉|重写|重新写|重新算|重来)/, label: '擦掉重写' },
  { re: /不对[，,：:]?\s*(应该|应当|正确)/, label: '否定后给出正确版本' },
  { re: /(漏写|漏了|漏掉|少写|多写|忘了写|忘写|没写|少了一步)/, label: '补写/漏写' },
];

/**
 * 找出讲稿里老师更正过的地方。
 * @param {Array<{start:number,text:string}>} segments 转写片段
 * @returns {Array<{t:number, text:string, label:string, next:string}>}
 */
export function findCorrections(segments = []) {
  const out = [];
  const list = segments.filter((s) => s && s.text);
  for (let i = 0; i < list.length; i++) {
    const s = list[i];
    const text = String(s.text).replace(/\s+/g, ' ').trim();
    if (!text) continue;
    const hit = CUES.find((c) => c.re.test(text));
    if (!hit) continue;
    // 同一处更正可能连着说好几句，10 秒内的合并成一条
    const last = out[out.length - 1];
    if (last && s.start - last.t < 10) {
      last.text = (last.text + ' ' + text).slice(0, 300);
      last.next = String(list[i + 1]?.text || '').slice(0, 160);
      continue;
    }
    out.push({
      t: s.start,
      text: text.slice(0, 300),
      label: hit.label,
      next: String(list[i + 1]?.text || '').slice(0, 160), // 紧跟着的一句，往往就是正确版本
    });
  }
  return out;
}

/** 给整理笔记的模型看的「更正清单」（只列出落在 [start,end] 内的）。 */
export function correctionsInRange(corrections, start, end) {
  return (corrections || []).filter((c) => c.t >= start - 1 && c.t <= end + 1);
}

/** 渲染成提示词里的一段文字。 */
export function renderCorrections(list) {
  if (!list.length) return '';
  const lines = ['\n【★老师在课堂上更正过的地方（整理时必须遵守）】'];
  for (const c of list) {
    lines.push(`- [${fmtClock(c.t)}]（${c.label}）「${c.text}」`);
    if (c.next) lines.push(`  紧接着说：「${c.next}」`);
  }
  lines.push(
    [
      '处理方式（很容易出错，务必照做）：',
      '1. 如果本片段讲的内容**在更靠后的时间被更正过**（更正时间晚于本片段），本片段直接写**更正后的正确版本**，并在该处加一行引用块：',
      '   > ⚠️ 此处老师在第 X 分钟更正过：原写法「……」已作废',
      '2. 如果本片段讲的内容**在更早的时间已经被更正过**，说明那个错误写法已经作废，本片段不要再重复它。',
      '3. 任何情况下都**不允许把已经作废的写法当作结论**写出来，也不要把「通用公式」「直接套用」这类说法加在已被否定的公式上。',
      '4. 更正时间在本片段之后的，不要提前展开讲那一段的内容，只需在相关结论旁标注一句。',
    ].join('\n'),
  );
  return lines.join('\n');
}

function fmtClock(sec) {
  const s = Math.max(0, Math.round(Number(sec) || 0));
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}
