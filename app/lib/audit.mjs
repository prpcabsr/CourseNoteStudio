// AI 审校：笔记成稿之后再请模型当一次「严格的审校员」，
// 找出**实质性错误**（公式错、结论错、条件缺失导致不成立、概念混淆），
// 并把问题定位到原文的具体一句话上，好在界面上用红色标记指出来。
//
// 为什么只报「根本错误」：
//   红色感叹号是很强的信号，误报会让人不敢信笔记。
//   所以宁可漏报，也不要把「表述不够严谨」「译名不统一」这类算进来。
import fs from 'node:fs';
import path from 'node:path';
import { projectPaths } from './project.mjs';
import { resolveLlmKey } from './config.mjs';
import { callLlm } from './fusion.mjs';
import { parseLlmJson } from './json.mjs';
import { readJson, writeJson } from './project.mjs';

function fmtClock(sec) {
  const s = Math.max(0, Math.round(Number(sec) || 0));
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}

const SYSTEM = `你是一位极其严格的大学数学/理科审校员，负责把笔记里**真正错误**的地方改对。

**最重要的一条：绝大多数情况下没有问题。** 一份正常的课堂笔记，逐节看下来通常是
{"items":[]}。**输出空数组是完全正常、也是绝大多数时候正确的答案。**
不要为了「给出更正」而勉强找问题 —— 误报的代价比漏报大得多：
错改一处，读者就会学到一个错的结论。

只报告下面这几类（都算 major，而且必须真的会让读者学错）：
1. 公式写错：上下标、系数、符号、正负号错，公式本身不成立；
2. 结论错误，或**条件缺失导致结论不成立**（例如把只对单极点成立的留数公式当成通用公式）；
3. **推断不成立**：笔记用一个条件推出了它推不出的结论。
   例如写「两根之积的模小于 1，配合两根互异，可断定恰有一根在单位圆内」——
   这个推断是错的（两根完全可以都在单位圆内），即使视频里老师其实用了别的条件判断。
   这类**必须报**：改正后的写法要补上真正成立的条件（例如「两根之和为 $-1$」），
   并在 videoTime 里给出老师实际讲到这个判断的位置。
4. 概念混淆到会算错的程度（例如把极点判据用在本质奇点上）；
5. 推导跳跃导致结果错、例题答案算错。

**明确不算错误，一律不要报**（报了就是误报）：
- 叫法/术语不够精准：例如「$n$ 阶孤立奇点」严格说该叫「$n$ 阶极点」、「单根点」该叫「单极点」、
  译名不统一 —— 只要不影响计算和结论，不算错误；
- 仅仅**省略了中间推导步骤、但方法本身正确、结论也对** —— 笔记本来就该比视频简略，不要报；
- 排版、错别字、标点、语言风格、口语化、语病、重复啰嗦（整理时已经改顺了）；
- 表述不够严谨、条件说得不够全但结论仍然成立、缺少证明细节；
- **只要你自己写出「不影响后续计算」「不影响结论」「更严谨的说法是」「概念上不够精确」这类判断，
  就说明它不是根本错误，直接不要报**；
- 你自己没有十足把握的怀疑 —— 拿不准就不报。

关于讲稿（带时间戳的那段材料）：
- 它是**口语**，本来就比笔记松散。**不要因为笔记和讲稿措辞不同就报错。**
- 它的用途有两个：① 定位老师讲到这一点的**视频时间**（每条都要尽量给出）；
  ② 看清老师**实际是怎么判断的** —— 笔记如果推断不成立，就照视频里的正确做法改。

关于 fixed（改正后的句子）：
- 必须是**实质不同**的正确写法。如果你写出的 fixed 和原句意思相同，说明这不是错误，**不要报这一条**。
- 保持原句的角色和长度量级，公式用 LaTeX 的 $...$，不加解释性文字。

输出 JSON，不要任何解释文字：
{"items":[{
  "severity":"major",
  "anchor":"原文中连续的一段文字，必须与原文逐字一致，10~60 字，用来定位要替换的句子",
  "title":"一句话说明这里的问题",
  "fixed":"改正后的句子（会直接替换 anchor）",
  "detail":"为什么错、为什么改后是对的（80~200 字，写给读者看）",
  "videoTime":"老师讲到这一点的位置，格式 mm:ss（找不到就空字符串）",
  "videoQuote":"老师讲到这一点时的原话片段（20~60 字，找不到就空字符串）"
}]}
没有问题就输出 {"items":[]}。`;

/** 在一节 markdown 里定位 anchor（精确 → 忽略空白 → 前几个字）。 */
export function locateInMarkdown(markdown, rawAnchor) {
  const plain = String(markdown || '');
  const anchor = String(rawAnchor || '').trim();
  if (!anchor || anchor.length < 4) return null;
  if (plain.includes(anchor)) return anchor;
  const compact = anchor.replace(/\s+/g, '');
  const lines = plain.split('\n');
  // 从原行的某个位置起，取「len 个非空白字符」——按字符数直接切会因为空格而少字
  const sliceFrom = (line, idx, len) => {
    let k = 0;
    let seen = 0;
    while (k < line.length && seen < idx) {
      if (!/\s/.test(line[k])) seen++;
      k++;
    }
    const start = k;
    let taken = 0;
    while (k < line.length && taken < len) {
      if (!/\s/.test(line[k])) taken++;
      k++;
    }
    return line.slice(start, k).trim();
  };
  for (const line of lines) {
    const i = line.replace(/\s+/g, '').indexOf(compact);
    if (i >= 0) return sliceFrom(line, i, anchor.length);
  }
  const head = compact.slice(0, 8);
  for (const line of lines) {
    const i = line.replace(/\s+/g, '').indexOf(head);
    if (i >= 0) return sliceFrom(line, i, anchor.length);
  }
  return null;
}

/** 宽松模式：连「推断不严谨」也标出来（默认关闭 —— 误改比漏改危险）。 */
const LOOSE_EXTRA = `
【本次以「宽松」标准审校】
除了上面那些，**还要**报告这一类：
- 推断不严谨、条件不足：结论也许碰巧成立，但笔记写出的依据推不出它。
  典型例子：「两根之积的模小于 1，配合两根互异，可断定恰有一根在单位圆内」——
  这个推断不成立（两根完全可以都在单位圆内）；视频里老师其实是用「两根之和为 $-1$」判断的。
  这种要报，并在 fixed 里补上真正成立的条件。
判断口径放宽到：**照着这句话去做，会不会做错**。会做错就报。`;

const VERIFY_LOOSE_EXTRA = `
【本次复核用「宽松」标准】
如果原句的**推断不成立**（用给的条件推不出所说的结论，照着做会做错），即使结论碰巧对，
也应当同意改正 —— 前提仍然是改法在数学上正确。`;

const VERIFY_SYSTEM = `你是复核员。有人声称下面这段课程笔记里的一句话**写错了**，并给出了改正后的写法。

请你**独立判断**，不要顺着对方的说法走。对方可能是错的 —— 统计上，多数「疑似错误」其实是原句没问题。

只有同时满足这两条，才同意（agree=true）：
1. 你能明确论证**原句确实不成立** —— 包括：公式本身错、结论错、
   或者**用一个条件推出了它推不出的结论**（推断不成立也算）；「不够严谨」「叫法不好」不算；
2. **改法在数学上正确**，而且确实修好了原句的问题（不是换个等价写法、不是改大小写、不是改数值）。

任何一条做不到、或者你有任何不确定，都输出 agree=false。
特别注意：如果原句只是符号取名不同（如 $a$ 与 $A$）、写法风格不同、或省略了中间步骤，
但结论成立，那**原句没错**，agree=false。

输出 JSON，不要解释文字：{"agree":true|false,"reason":"一句话说明理由"}`;

/** 对一条「疑似错误 + 改法」做独立复核，只有复核同意才允许改动正文。 */
async function verifyFix({ section, item, cfg, signal, loose = false }) {
  const messages = [
    { role: 'system', content: VERIFY_SYSTEM + (loose ? VERIFY_LOOSE_EXTRA : '') },
    {
      role: 'user',
      content: [
        `【所在小节】第 ${section.index + 1} 节：${section.title}`,
        '',
        '【小节全文】',
        section.markdown.slice(0, 6000),
        '',
        '【被指为错误的那句话】',
        item.anchor,
        '',
        '【对方给出的改法】',
        item.fixed,
        '',
        '【对方的理由】',
        item.detail,
      ].join('\n'),
    },
  ];
  try {
    const { content } = await callLlm({ cfg, messages, onEvent: () => {}, signal, temperature: 0 });
    const out = parseLlmJson(content, '复核改法');
    return { agree: out?.agree === true, reason: String(out?.reason || '').slice(0, 200) };
  } catch {
    return { agree: false, reason: '复核失败' };
  }
}

/** 审校一节。 */
async function auditSection({ section, segments = [], cfg, cacheDir, bustCache, signal, onEventLog = () => {}, loose = false }) {
  const key = `s${String(section.index).padStart(2, '0')}${loose ? '-loose' : ''}`;
  const cacheFile = path.join(cacheDir, key + '.json');
  if (!bustCache && fs.existsSync(cacheFile)) {
    const hit = readJson(cacheFile);
    if (hit) return hit;
  }
  // 把这一节的讲稿（带时间戳）也给模型：① 判断「笔记只是简略还是真错」
  // ② 找出老师在视频里讲这一点的位置
  const transcript = segments.length
    ? '\n\n【这一节的课堂讲稿（带时间戳，用于核对与定位视频位置）】\n' +
      segments.map((s) => `[${fmtClock(s.start)}] ${s.text}`).join('\n')
    : '';
  const messages = [
    { role: 'system', content: SYSTEM + (loose ? LOOSE_EXTRA : '') },
    {
      role: 'user',
      content: `下面是一节课程笔记的其中一节（第 ${section.index + 1} 节：${section.title}，视频 ${fmtClock(section.start)}–${fmtClock(section.end)}）。请审校并给出更正。${transcript}\n\n──────── 笔记正文 ────────\n${section.markdown}`,
    },
  ];
  const { content } = await callLlm({ cfg, messages, onEvent: () => {}, signal, temperature: 0.05 });
  const out = parseLlmJson(content, `第 ${section.index + 1} 节审校`);
  const raw = Array.isArray(out?.items) ? out.items : [];
  const candidates = [];
  for (const it of raw) {
    // 只留 major：误报比漏报更伤信任
    if (String(it.severity || '').toLowerCase() !== 'major') continue;
    const anchor = locateInMarkdown(section.markdown, it.anchor);
    if (!anchor) continue; // 定位不到就不动它，避免改错地方
    const title = String(it.title || '').trim().slice(0, 120);
    const detail = String(it.detail || '').trim().slice(0, 800);
    const fixed = String(it.fixed || '').trim().slice(0, 600);
    if (!title || !detail || !fixed) continue; // 没有给出更正就不改（宁可不标）
    // 兜底：如果「改正后」和原句实质相同，说明这不是错误（模型硬凑的），丢掉
    const norm = (t) => String(t).replace(/\s+/g, '').replace(/[，。；：、,.;:]/g, '').replace(/\$/g, '');
    if (norm(fixed) === norm(anchor)) continue;
    // 视频位置：优先用模型给的时间，格式化成 mm:ss
    let videoTime = String(it.videoTime || '').trim();
    if (videoTime && !/^\d{1,2}:\d{2}$/.test(videoTime)) videoTime = '';
    const videoQuote = String(it.videoQuote || '').trim().slice(0, 200);
    candidates.push({
      section: section.index,
      sectionTitle: section.title,
      anchor,
      title,
      detail,
      fixed,
      videoTime,
      videoQuote,
    });
  }
  // 关键一步：改正文之前先让另一个调用独立复核。
  // 「让模型改错」本身会引入新错误（实测出现过把 a²<1 改成 =1 的情况），
  // 所以只有复核同意的改动才会写进笔记；不同意的直接丢掉，宁可漏改。
  const items = [];
  let rejected = 0;
  for (const c of candidates) {
    const v = await verifyFix({ section, item: c, cfg, signal, loose });
    if (v.agree) {
      items.push({ ...c, verified: true, verifyReason: v.reason });
    } else {
      rejected++;
      onEventLog(`第 ${section.index + 1} 节有一条被复核否掉：${c.anchor.replace(/\s+/g, ' ').slice(0, 40)}… —— ${v.reason}`);
    }
  }
  if (candidates.length) {
    onEventLog(`第 ${section.index + 1} 节：初筛 ${candidates.length} 条，复核通过 ${items.length} 条`);
  }
  writeJson(cacheFile, items);
  return items;
}

/**
 * 审校整份笔记。
 * @returns {Promise<Array>} 问题列表（只含 major，且已定位到原文）
 */
export async function auditNotes({ projectId, cfg, onEvent = () => {}, signal, concurrency = 3, bustCache = false }) {
  const P = projectPaths(projectId);
  const docFile = path.join(P.work, 'doc.json');
  if (!fs.existsSync(docFile)) throw new Error('还没有成稿，先跑一次笔记整理');
  const doc = readJson(docFile);
  if (!resolveLlmKey(cfg)) throw new Error('没有可用的文本模型 Key，无法审校');

  const sections = (doc.sections || []).filter((s) => (s.markdown || '').trim().length > 40);
  if (!sections.length) return [];
  // 严格程度：strict 只改「确定的数学错误」；loose 连「推断不严谨」也标出来并改正
  const loose = String(cfg?.audit?.strictness || 'strict') === 'loose';
  const cacheDir = path.join(P.work, 'audit');
  fs.mkdirSync(cacheDir, { recursive: true });
  onEvent({
    type: 'log',
    message: `AI 审校：逐节检查 ${sections.length} 节的公式与结论…${loose ? '（宽松：推断不严谨也标）' : ''}`,
  });

  // 讲稿按节切好（审校要据此判断「笔记只是简略」还是「真写错了」，并定位视频位置）
  const transcriptFile = path.join(P.work, 'transcript.json');
  const transcript = fs.existsSync(transcriptFile) ? readJson(transcriptFile) : null;
  const allSegs = transcript?.segments || [];

  const results = new Array(sections.length);
  const queue = sections.map((s, i) => ({ s, i }));
  const workers = new Array(Math.max(1, Math.min(concurrency, queue.length))).fill(0).map(async () => {
    while (queue.length) {
      const { s, i } = queue.shift();
      const segs = allSegs.filter((x) => x.start >= (s.start || 0) - 2 && x.start <= (s.end || 0) + 2);
      try {
        results[i] = await auditSection({
          section: s,
          segments: segs,
          cfg,
          cacheDir,
          bustCache,
          signal,
          onEventLog: (msg) => onEvent({ type: 'log', message: msg }),
          loose,
        });
      } catch (e) {
        onEvent({ type: 'log', message: `第 ${s.index + 1} 节审校失败：${e.message}`, level: 'warn' });
        results[i] = [];
      }
    }
  });
  await Promise.all(workers);

  const items = results.flat().filter(Boolean);
  const out = { at: new Date().toISOString(), model: cfg?.llm?.model || '', items };
  writeJson(path.join(P.work, 'audit.json'), out);
  // 同时挂进 doc.json，出稿时会把红标烧进 HTML（这样关掉 AI 批注也看得见）
  doc.audit = items;
  writeJson(docFile, doc);
  onEvent({
    type: 'log',
    level: items.length ? 'warn' : 'ok',
    message: items.length
      ? `AI 审校完成：发现 ${items.length} 处实质性问题，已在成稿里用红色感叹号标出`
      : 'AI 审校完成：没有发现实质性问题',
  });
  return items;
}

/** 读取审校结果（没有就返回空）。 */
export function loadAudit(projectId) {
  const file = path.join(projectPaths(projectId).work, 'audit.json');
  if (!fs.existsSync(file)) return { items: [] };
  return readJson(file) || { items: [] };
}
