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

const SYSTEM = `你是一位极其严格的大学数学/理科审校员。你的任务是审核课程笔记里有没有**实质性错误**。

只报告下面这几类（都算 major）：
1. 公式写错：上下标、系数、符号、正负号错，公式本身不成立；
2. 结论错误，或**条件缺失导致结论不成立**（例如把只对单极点成立的留数公式说成通用公式）；
3. 概念混淆、定义张冠李戴（例如把极点判据用在本质奇点上）；
4. 推导跳跃导致结果错、例题答案算错。

**不要报告**（这些不算根本错误，报了就属于误报）：
- 排版、错别字、标点不规范、术语译名不统一、语言风格问题；
- **口语化表达、语病、重复啰嗦、说话不完整** —— 这些是课堂口语的常态，整理时顺手改顺即可，不要报；
- **表述不够严谨、条件说得不够全但结论没错**、缺少证明细节、省略中间步骤；
- **只要你自己写出「不影响后续计算」「不影响结论」「更严谨的说法是」这类判断，就说明它不是根本错误，直接不要报**；
- 你自己没有十足把握的怀疑 —— 拿不准就不报。

判断标准只有一个：**照着这段文字学，会不会学到一个错误的结果**。
会（公式错、结论错、把不适用的公式当通用、概念张冠李戴）→ 报；
不会（只是叫法、写法、严谨程度、说话方式）→ **一律不报，这些在整理笔记时已经处理过了**。

输出 JSON，不要任何解释文字：
{"items":[{"severity":"major","anchor":"原文中连续的一段文字，必须与原文逐字一致，10~40 个字，选最能定位问题的那个公式或那句话","title":"一句话说明问题","detail":"错在哪里、为什么错、正确的应该是什么（80~200 字）"}]}
整节都没有实质错误时输出 {"items":[]}。`;

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

/** 审校一节。 */
async function auditSection({ section, cfg, cacheDir, bustCache, signal }) {
  const key = `s${String(section.index).padStart(2, '0')}`;
  const cacheFile = path.join(cacheDir, key + '.json');
  if (!bustCache && fs.existsSync(cacheFile)) {
    const hit = readJson(cacheFile);
    if (hit) return hit;
  }
  const messages = [
    { role: 'system', content: SYSTEM },
    {
      role: 'user',
      content: `下面是一节课程笔记的其中一节（第 ${section.index + 1} 节：${section.title}）。请审校。\n\n${section.markdown}`,
    },
  ];
  const { content } = await callLlm({ cfg, messages, onEvent: () => {}, signal });
  const out = parseLlmJson(content, `第 ${section.index + 1} 节审校`);
  const raw = Array.isArray(out?.items) ? out.items : [];
  const items = [];
  for (const it of raw) {
    // 只留 major：误报比漏报更伤信任
    if (String(it.severity || '').toLowerCase() !== 'major') continue;
    const anchor = locateInMarkdown(section.markdown, it.anchor);
    if (!anchor) continue; // 定位不到就不标，避免标错地方
    const title = String(it.title || '').trim().slice(0, 120);
    const detail = String(it.detail || '').trim().slice(0, 800);
    if (!title || !detail) continue;
    items.push({ section: section.index, sectionTitle: section.title, anchor, title, detail });
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
  const cacheDir = path.join(P.work, 'audit');
  fs.mkdirSync(cacheDir, { recursive: true });
  onEvent({ type: 'log', message: `AI 审校：逐节检查 ${sections.length} 节的公式与结论…` });

  const results = new Array(sections.length);
  const queue = sections.map((s, i) => ({ s, i }));
  const workers = new Array(Math.max(1, Math.min(concurrency, queue.length))).fill(0).map(async () => {
    while (queue.length) {
      const { s, i } = queue.shift();
      try {
        results[i] = await auditSection({ section: s, cfg, cacheDir, bustCache, signal });
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
