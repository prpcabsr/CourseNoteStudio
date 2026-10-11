// 「想」：把讲稿 + 板书内容按时间轴对齐，交给大模型整理成结构化的课程笔记。
import fs from 'node:fs';
import path from 'node:path';
import { resolveLlmKey } from './config.mjs';
import { findCorrections, renderCorrections } from './corrections.mjs';
import { repairLatex } from './latex.mjs';

const WINDOW_MINUTES = 7;

export function fmtTime(t) {
  const s = Math.max(0, Math.floor(t));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return h > 0
    ? `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`
    : `${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
}

/** 调用 OpenAI 兼容的对话接口（默认 DeepSeek）。 */
export async function callLlm({ cfg, messages, json = false, onEvent = () => {}, signal, maxRetry = 3, temperature = null }) {
  const { key, source } = resolveLlmKey(cfg);
  if (!key) {
    throw new Error(
      '还没有配置文本模型 API Key。请打开网页右上角「环境与模型 → 文本模型」，' +
        '填入你自己的 DeepSeek（或任意 OpenAI 兼容接口）Key 后重新运行；前面几步（下载、转写、识别板书）已经完成，不会重跑。',
    );
  }
  const url = cfg.llm.baseUrl.replace(/\/$/, '') + '/chat/completions';
  const body = {
    model: cfg.llm.model,
    messages,
    temperature: temperature ?? cfg.llm.temperature ?? 0.3,
    max_tokens: cfg.llm.maxTokens ?? 4096,
    stream: false,
  };
  if (json) body.response_format = { type: 'json_object' };
  let lastErr;
  for (let attempt = 0; attempt < maxRetry; attempt++) {
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
        body: JSON.stringify(body),
        signal,
      });
      if (!res.ok) {
        const t = await res.text();
        if (res.status === 429 || res.status >= 500) throw new Error(`HTTP ${res.status}: ${t.slice(0, 200)}`);
        throw Object.assign(new Error(`模型接口错误 ${res.status}：${t.slice(0, 300)}`), { fatal: true });
      }
      const j = await res.json();
      const content = j.choices?.[0]?.message?.content ?? '';
      return { content, usage: j.usage, keySource: source };
    } catch (e) {
      lastErr = e;
      if (e.fatal || signal?.aborted) throw e;
      onEvent({ type: 'log', level: 'warn', message: `模型调用重试（${attempt + 1}/${maxRetry}）：${e.message}` });
      await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)));
    }
  }
  throw lastErr;
}

const SYSTEM_WRITER = `你是一位顶尖的大学课程笔记整理专家。你的任务是把课堂录音转写稿和板书识别结果，整理成**准确、完整、逻辑清晰**的课程笔记。

铁律：
1. 事实优先：只能使用给定材料中的信息。不允许编造材料里没有的定义、数据、结论。材料没讲清楚的地方，写「（此处录音不清）」或直接省略，绝不猜测填充。
2. 术语纠错：语音转写常把专业术语写错（同音字、英文缩写），请依据上下文和你的学科知识改正，例如把「极限」写成「极限」而不是「基限」。改正后在括号中不解释，直接使用正确写法。
3. 板书优先：板书是老师亲手写下的核心内容，是笔记的骨架。公式、定理、定义、例题步骤必须以板书为准。
4. 结构化：使用 Markdown。用 ## 分节、### 分小节，列表、表格、粗体突出关键结论。
5. 数学公式用 LaTeX：行内 $...$，独立公式 $$...$$。
6. 加入思考：在合适的地方补充「为什么这样做」「这一步的动机」「容易出错的地方」，但必须写明这是整理者的理解，用「▸ 理解」标记，与老师原话区分开。
6.1 **顺手把口语整顺**：老师的原话是口语，常有语病、重复、半截话、语气词（「这个这个」「对吧」「咱们」「就是」「呃」）。整理时直接改写成规范、简洁的书面表达，**不要原样照抄，也不要加任何说明**（例如不要写「老师原话说得不太严谨，应该是…」）。这是整理笔记的默认动作，不需要标出来。
6.2 术语与说法统一到教材规范：老师口语里把「单根点」说成「极点」、把「罗朗」说成「洛朗」之类，一律采用教材常见译名；除非这会改变数学含义，否则不必说明。
7. 不要写「老师说」「录音中提到」这类话，直接写内容本身。
8. 忽略与课程无关的杂音：视频水印、UP 主昵称、台标、弹幕、时间码、摄像头机位标注（如「教师机位」）、走廊闲聊。这些不要写进笔记。
9. **公式规范化**：材料里的公式是机器识别来的，上下标经常错位或丢花括号。你必须把它们改写成规范的 LaTeX 再写进笔记，规则：
   - 积分号、求和号的上下限一定要用花括号：写 $\sum_{k=1}^{n}$ 而不是 $\sum k=1 n$；写 $\oint_{L}$ 而不是 $\oint L$；
   - 极限写 $\lim_{x \to x_0} f(x)$；留数写 $\operatorname{Res}_{z=b_k} f(z)$；
   - 多字符下标用花括号包起来：$b_k$、$x_0$、$a_{ij}$，不要写成 bk、x0、aij；
   - 独立成行的公式用 $$...$$，行内用 $...$。
10. **每一个数学符号都必须包在 $...$ 里，一个都不能漏**。这是最常出错的地方：把 $C_{-1}$ 写成 C_{-1}、把 $e^{1/z}$ 写成 e^{1/z}、把 $z=0$ 写成 z=0，在成稿里就会原样显示成「C_{-1}」「e^{1/z}」这种难看的裸文本。所以：
   - 只要出现下标、上标、等号、分式、希腊字母、括起来的表达式，就必须用 $...$ 包起来；
   - 概览、学习目标、术语表、自测题这些**叙述性段落里同样要包**，不要以为「正文公式才需要 $」；
   - 检查方法：写完后扫一遍自己的输出，凡是能看到下划线、脱字符、等号、斜杠而没有被 $ 包住的地方，都要补上。
11. **用词统一**：同一个术语在一篇笔记里只能有一种写法（例如「洛朗级数」和「罗朗级数」不能混用，「柯西定理」和「科西定理」不能混用）。以教材常见译名为准，首次出现后可加英文原词。
12. **以最终版本为准（老师更正过的地方）**：老师上课时常会过一会儿发现写错了，擦掉重写或口头更正。这种情况下：
    - **只保留更正后的正确版本**，绝不把已经作废的错误写法当成结论写进笔记；
    - 在更正处写一行引用块标注清楚，格式：\`> ⚠️ 此处老师曾更正：[原来错在哪] → [最终写法]\`；
    - 材料里会给出「★老师在课堂上更正过的地方」清单，里面有时间点和原话，必须逐条落实；
    - 板书抓拍是按时间排列的：如果后面的抓拍把前面某处擦掉重写了（标注「★这块板书之后被擦掉/改写」），说明老师改过它，**以最后一次写下的为准**；
    - 如果材料不足以判断最终版本是什么，就写「（此处老师有更正，以板书最终版本为准）」并**保留最终那一版**，绝不允许把两个互相矛盾的版本并排列出而不加说明。
13. 输出简体中文。`;

/** 把时间轴切成若干时间窗。 */
export function buildWindows({
  transcript,
  snapshots,
  duration,
  windowMinutes = WINDOW_MINUTES,
  corrections = [],
}) {
  const total = Math.max(duration || 0, snapshots.at(-1)?.t || 0, transcript?.segments?.at(-1)?.end || 0);
  const win = windowMinutes * 60;
  const n = Math.max(1, Math.ceil(total / win));
  const windows = [];
  for (let i = 0; i < n; i++) {
    const start = i * win;
    const end = Math.min(total, (i + 1) * win);
    const segs = (transcript?.segments || []).filter((s) => s.start >= start - 2 && s.start < end + 2);
    const snaps = snapshots.filter((s) => s.t >= start - 3 && s.t < end + 3);
    // 更正清单必须**下发到每一个窗口**：
    //   · 更正可能发生在很后面（老师讲了 10 分钟才发现写错），
    //     而写前面那一段时如果看不到更正，就会把作废的写法当成结论写死；
    //   · 也可能发生在前面，此时本段不该再重复错误写法。
    // 清单本身很短（每条几百字），全量下发代价可以接受。
    windows.push({ index: i, start, end, segments: segs, snapshots: snaps, corrections });
  }
  return windows;
}

function renderWindowMaterial(w) {
  const lines = [];
  lines.push(`【时间范围】${fmtTime(w.start)} - ${fmtTime(w.end)}（本节课第 ${w.index + 1} 个时间片段）`);
  if (w.segments.length) {
    lines.push('\n【课堂录音转写（含时间戳）】');
    for (const s of w.segments) lines.push(`[${fmtTime(s.start)}] ${s.text}`);
  } else {
    lines.push('\n【课堂录音转写】本片段没有可用的语音内容。');
  }
  const boards = w.snapshots.filter((s) => (s.ocr?.text || '').trim().length > 1);
  if (boards.length) {
    lines.push('\n【板书识别结果（按时间顺序；同一块板书的后续抓拍包含前面内容）】');
    for (const b of boards) {
      const tag = b.erased ? '★这块板书之后被擦掉/改写了（若与前面某屏冲突，以最后写下的为准）' : '';
      lines.push(`--- 板书抓拍 @${fmtTime(b.t)}（第 ${b.generation + 1} 块板书）${tag}`);
      if (b.ocr.title) lines.push(`标题：${b.ocr.title}`);
      lines.push(repairLatex(b.ocr.text).trim());
    }
  } else {
    lines.push('\n【板书识别结果】本片段没有识别到板书内容。');
  }
  // 这一段里老师更正过的地方：必须交给模型，否则错误写法会留在笔记里
  const fixes = w.corrections || [];
  if (fixes.length) lines.push(renderCorrections(fixes));
  return lines.join('\n');
}

const WINDOW_INSTRUCTION = (w) => `下面是一节大学课程中第 ${w.index + 1} 个时间片段的原始材料。请把它整理成这一段的课程笔记。

输出要求（Markdown）：
- 第一行是这一段的标题，格式：## <标题>（标题要概括这一段实际讲的内容，不要用「片段1」这种名字）
- 然后按知识点分小节写正文，包含：概念/定义、老师的推导过程、例题步骤、关键结论。
- 每个知识点尽量标注时间，格式：（${fmtTime(w.start)} 起）这样的区间可以省略，只在关键处用 \`[mm:ss]\` 标注。
- 板书里出现的公式、定理、例题必须完整保留，不要因为是公式就跳过。
- 如果这一段内容很少（例如只是课间休息、闲聊、调试设备），就只输出标题和一行说明，不要编内容。
- 直接输出 Markdown 正文，不要任何解释性开场白。

${renderWindowMaterial(w)}`;

/** 生成一个时间窗的笔记（带缓存）。 */
async function writeWindow({ w, cfg, cacheDir, onEvent, signal, bustCache }) {
  const cacheFile = path.join(cacheDir, `window_${String(w.index).padStart(3, '0')}.json`);
  if (!bustCache && fs.existsSync(cacheFile)) {
    try {
      const c = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
      if (c.markdown && c.inputHash === hashMaterial(w)) return c;
    } catch {}
  }
  const { content } = await callLlm({
    cfg,
    messages: [
      { role: 'system', content: SYSTEM_WRITER },
      { role: 'user', content: WINDOW_INSTRUCTION(w) },
    ],
    onEvent,
    signal,
  });
  const markdown = content.trim();
  const titleMatch = markdown.match(/^#{2,3}\s*(.+)$/m);
  const result = {
    index: w.index,
    start: w.start,
    end: w.end,
    title: titleMatch ? titleMatch[1].trim() : `第 ${w.index + 1} 段`,
    markdown,
    inputHash: hashMaterial(w),
  };
  fs.mkdirSync(cacheDir, { recursive: true });
  fs.writeFileSync(cacheFile, JSON.stringify(result, null, 2), 'utf8');
  return result;
}

function hashMaterial(w) {
  const s = w.segments.map((x) => x.text).join('') + '|' + w.snapshots.map((x) => (x.ocr?.text || '').slice(0, 200)).join('');
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return String(h);
}

const MERGE_INSTRUCTION = (sections, meta) => `下面是一门大学课程《${meta.title || '未命名课程'}》各个时间片段的笔记。请生成整门课的总体信息。

严格输出 JSON（不要代码块标记），字段：
{
  "title": "规范的课程/讲次标题",
  "subtitle": "一句话概括本讲内容（不超过 40 字）",
  "overview": "本讲内容概览，200-400 字，说明这讲围绕什么展开、脉络是什么",
  "objectives": ["学习目标1","学习目标2","学习目标3"],
  "sections": [{"index": 0, "title": "优化后的章节标题"}],
  "formulas": "Markdown：本讲出现的关键公式/定理汇总，每条一行，用 LaTeX，并附一句话含义。若没有公式则填空字符串",
  "glossary": "Markdown 表格：| 术语 | 含义 |，列出本讲的关键概念，10 条以内",
  "quiz": "Markdown：5 道复习自测题（含简答要点），用于检验是否掌握"
}

要求：
- sections 必须覆盖全部 ${sections.length} 个片段，index 从 0 开始，标题要连贯、有逻辑顺序、去掉重复。
- 所有内容只能来自下面的笔记，不要编造。
- 使用简体中文。

各片段笔记：
${sections.map((s) => `\n===== 片段 ${s.index}（${fmtTime(s.start)}-${fmtTime(s.end)}）=====\n${s.markdown}`).join('\n')}`;

/** 总合成：概览 + 章节标题润色 + 公式汇总 + 术语表 + 自测题。 */
async function mergeNotes({ sections, meta, cfg, cacheDir, onEvent, signal, bustCache }) {
  const cacheFile = path.join(cacheDir, 'merged.json');
  const hash = String(sections.reduce((a, s) => a + s.markdown.length + s.index, 0));
  if (!bustCache && fs.existsSync(cacheFile)) {
    try {
      const c = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
      if (c.hash === hash) return c;
    } catch {}
  }
  const { content } = await callLlm({
    cfg,
    messages: [
      { role: 'system', content: SYSTEM_WRITER },
      { role: 'user', content: MERGE_INSTRUCTION(sections, meta) },
    ],
    json: true,
    onEvent,
    signal,
  });
  let obj;
  try {
    obj = parseLlmJson(content, '整体汇总');
  } catch {
    obj = { title: meta.title, subtitle: '', overview: '', objectives: [], sections: [], formulas: '', glossary: '', quiz: '' };
    onEvent({ type: 'log', level: 'warn', message: '整体汇总解析失败，已跳过概览部分' });
  }
  obj.hash = hash;
  fs.mkdirSync(cacheDir, { recursive: true });
  fs.writeFileSync(cacheFile, JSON.stringify(obj, null, 2), 'utf8');
  return obj;
}

/** 把板书抓拍分配到对应时间窗（每个窗口最多若干张，优先保留被擦除前的完整板书）。 */
function pickImages(w, max = 4) {
  const boards = w.snapshots.filter((s) => (s.ocr?.text || '').trim().length > 1 && s.imagePath);
  if (!boards.length) return [];
  const byGen = new Map();
  for (const b of boards) {
    const arr = byGen.get(b.generation) || [];
    arr.push(b);
    byGen.set(b.generation, arr);
  }
  const picked = [];
  for (const [, arr] of byGen) {
    picked.push(arr[arr.length - 1]); // 每块板书的最后（最完整）一屏
  }
  picked.sort((a, b) => a.t - b.t);
  if (picked.length <= max) return picked;
  // 均匀取样
  const out = [];
  for (let i = 0; i < max; i++) out.push(picked[Math.round((i * (picked.length - 1)) / (max - 1))]);
  return [...new Set(out)];
}

/** 主入口。 */
export async function synthesize({ transcript, snapshots, duration, meta, cfg, cacheDir, onEvent = () => {}, signal, concurrency = 3, bustCache = false }) {
  // 先找出老师更正过的地方：板书按住「一代一代」全部保留，
  // 错误的那一版也在材料里，必须明确告诉模型以更正后的版本为准
  const corrections = findCorrections(transcript?.segments || []);
  if (corrections.length) {
    onEvent({
      type: 'log',
      message: `检测到 ${corrections.length} 处老师更正（${corrections.map((c) => fmtTime(c.t)).join('、')}），已要求只保留最终版本`,
      level: 'warn',
    });
  }
  const windows = buildWindows({ transcript, snapshots, duration, corrections });
  onEvent({ type: 'log', message: `按时间轴切成 ${windows.length} 个片段，开始逐段整理…` });
  const sections = new Array(windows.length);
  let done = 0;
  const queue = [...windows];
  const workers = new Array(Math.max(1, Math.min(concurrency, windows.length))).fill(0).map(async () => {
    while (queue.length) {
      const w = queue.shift();
      const s = await writeWindow({ w, cfg, cacheDir, onEvent, signal, bustCache });
      sections[w.index] = s;
      done++;
      onEvent({ type: 'note-progress', percent: Math.round((done / windows.length) * 100), title: s.title, index: w.index });
      onEvent({ type: 'section-done', section: { ...s, images: [] } });
    }
  });
  await Promise.all(workers);

  const merged = await mergeNotes({ sections, meta, cfg, cacheDir, onEvent, signal, bustCache });
  const titleMap = new Map((merged.sections || []).map((s) => [s.index, s.title]));

  const finalSections = sections.map((s, i) => {
    const w = windows[i];
    const images = pickImages(w);
    let md = s.markdown;
    const newTitle = titleMap.get(i);
    if (newTitle) {
      md = md.replace(/^(#{2,3})\s*(.+)$/m, `$1 ${newTitle}`);
    }
    return {
      index: i,
      start: s.start,
      end: s.end,
      title: newTitle || s.title,
      markdown: md,
      images: images.map((b) => ({
        path: b.imagePath,
        t: b.t,
        generation: b.generation,
        erased: !!b.erased,
        relPath: path.basename(b.imagePath),
      })),
    };
  });

  // 板书时间线（用于附录，体现「擦掉的板书也保留」）
  const timeline = snapshots
    .filter((s) => (s.ocr?.text || '').trim().length > 1)
    .map((s) => ({
      t: s.t,
      generation: s.generation,
      erased: !!s.erased,
      title: repairLatex(s.ocr?.title || ''),
      text: repairLatex(s.ocr?.text || ''),
      relPath: s.imagePath ? path.basename(s.imagePath) : '',
    }));

  return {
    title: merged.title || meta.title || '课程笔记',
    subtitle: merged.subtitle || '',
    overview: merged.overview || '',
    objectives: merged.objectives || [],
    formulas: merged.formulas || '',
    glossary: merged.glossary || '',
    quiz: merged.quiz || '',
    sections: finalSections,
    timeline,
    // 老师更正过的地方：写进附录，方便你核对「作废的写法有没有被清掉」
    corrections,
    generatedAt: new Date().toISOString(),
  };
}
