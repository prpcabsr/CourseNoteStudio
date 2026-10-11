// AI 补充：找出课程里「没讲到、但理解本节很关键」的知识点，写成旁注。
//
// 产物存在 work/supplements.json：
//   [{ section, anchor, title, short, more }]
//     section —— 第几节（1 起）
//     anchor  —— 该节正文里的一小段原文，前端据此把批注挂到对应段落旁边
//     short   —— 旁注（尽量简洁，一兩句话）
//     more    —— 「了解更多」里的详细解释
import fs from 'node:fs';
import path from 'node:path';
import { projectPaths, loadState, readJson, writeJson } from './project.mjs';
import { callLlm } from './fusion.mjs';
import { parseLlmJson } from './json.mjs';
import { mdToHtml } from './render.mjs';

/** 旁注很短，一行内联公式：排好版但不要 <p> 包裹。 */
function inlineMathHtml(text) {
  return mdToHtml(String(text)).replace(/^<p>|<\/p>\s*$/g, '');
}

const SYSTEM = `你是一位非常擅长「补背景」的大学助教。学生手上有一份课堂笔记，你要找出**课上没讲、但不懂就会卡住**的关键点，写成旁注。

挑什么（按优先级）：
1. 笔记里用到却没解释的前置知识（某个定理的前提、某个记号的含义、某个公式的适用条件）；
2. 最容易误解、最容易算错的地方（符号约定、方向、边界情形、特例）；
3. 一句话就能建立的直观图像（这个式子到底在说什么、几何意义）；
4. 与相邻知识点的联系（和前面哪一节呼应、以后在哪里会用到）。

不要挑什么：
- 不要复述笔记里已经写清楚的内容；
- 不要补充与本节无关的拓展、历史八卦、超纲难题；
- 不要泛泛而谈「要注意理解」这种空话。

写法要求：
- 「short」是写在书页空白处的旁注：**不超过 50 个字**，直接给结论或提醒，不要客套话，不要「本节课」这种前缀。
- 「more」是点「了解更多」之后的详细解释：150～300 字，讲清楚「是什么、为什么、怎么用」，可以用一个极简例子。涉及公式用 LaTeX（行内 $...$，独立 $$...$$）。
- 「anchor」必须从该节正文里**原样摘录连续的一小段文字**（8～25 字，最好是不含公式和标点的短语），前端靠它把批注定位到那一段旁边。不要自己改字。
- 「title」4～10 个字，概括这条补的是什么。

输出严格 JSON：
{"items":[{"section":1,"anchor":"原文片段","title":"标题","short":"旁注","more":"详细解释"}]}
最多 10 条，宁缺毋滥；如果确实没有值得补的，就返回 {"items":[]}。`;

/** 把每节的正文按段落切出来，供模型挑锚点。 */
function sectionText(md, limit = 1800) {
  return String(md || '')
    .split(/\n\s*\n/)
    .map((s) => s.replace(/^#{1,4}\s*/gm, '').replace(/\s+/g, ' ').trim())
    .filter((s) => s.length > 12)
    .join('\n')
    .slice(0, limit);
}

/**
 * 把模型给的 anchor 对上正文。
 * 精确匹配 → 忽略空白的匹配 → 退一步拿前几个字找那一行，
 * 都对不上才返回空（界面会把批注落到该节第一段）。
 */
function locateAnchor(markdown, rawAnchor) {
  const plain = String(markdown || '');
  const anchor = String(rawAnchor || '').trim();
  if (!anchor) return '';
  if (plain.includes(anchor)) return anchor;

  const compact = anchor.replace(/\s+/g, '');
  const lines = plain.split('\n');
  // 从原行的某个位置起，取「len 个非空白字符」——按字符数直接切会因为空格而少字
  const sliceFrom = (line, compactIdx, len) => {
    let k = 0;
    let seen = 0;
    while (k < line.length && seen < compactIdx) {
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
  if (compact.length >= 4) {
    for (const line of lines) {
      const i = line.replace(/\s+/g, '').indexOf(compact);
      if (i >= 0) return sliceFrom(line, i, anchor.length);
    }
    // 模糊：拿开头几个字找那一行（模型可能改了几个字或标点）
    const head = compact.slice(0, 8);
    for (const line of lines) {
      const i = line.replace(/\s+/g, '').indexOf(head);
      if (i >= 0) return sliceFrom(line, i, anchor.length);
    }
  }
  return '';
}

export async function generateSupplements({ projectId, cfg, onEvent = () => {} }) {
  const P = projectPaths(projectId);
  const doc = readJson(path.join(P.work, 'doc.json'));
  if (!doc || !doc.sections?.length) throw new Error('还没有成稿，先生成一次笔记再补充');
  const state = loadState(projectId) || {};

  const outline = doc.sections
    .map((s, i) => {
      const body = sectionText(s.markdown);
      if (body.length < 40) return '';
      return `【第 ${i + 1} 节】${s.title || ''}\n${body}`;
    })
    .filter(Boolean)
    .join('\n\n');

  const user = [
    `课程：${state.title || doc.title || ''}`,
    doc.overview ? `本讲概览：${String(doc.overview).slice(0, 800)}` : '',
    '',
    '以下是各节笔记正文（节号用于输出时对应）：',
    outline,
  ]
    .filter(Boolean)
    .join('\n');

  onEvent({ type: 'supplement-start' });
  const { content } = await callLlm({
    cfg,
    messages: [
      { role: 'system', content: SYSTEM },
      { role: 'user', content: user },
    ],
    json: true,
  });

  let parsed;
  try {
    parsed = parseLlmJson(content, 'AI 补充结果');
  } catch (e) {
    throw new Error(`AI 补充失败：${e.message}（可以再点一次重试）`);
  }

  // 校验 + 归一：section 越界丢弃、anchor 必须在正文里真的出现
  const items = [];
  for (const it of parsed.items || []) {
    const n = Number(it.section);
    const sec = doc.sections[n - 1];
    if (!sec) continue;
    const plain = String(sec.markdown || '');
    const anchor = locateAnchor(plain, it.anchor);
    const short = String(it.short || '').trim();
    const more = String(it.more || '').trim();
    if (!short) continue;
    items.push({
      section: n,
      sectionTitle: String(sec.title || '').trim(),
      anchor,
      anchorRaw: String(it.anchor || '').trim(), // 留档：模型原话，方便排查为什么对不上
      title: String(it.title || '').trim(),
      short,
      // 提前在服务端把公式排好版，前端（尤其是成稿 iframe 里）直接插入即可
      shortHtml: inlineMathHtml(short),
      moreHtml: mdToHtml(more).replace(/^<p>|<\/p>\s*$/g, ''),
      more,
      generatedAt: new Date().toISOString(),
    });
  }

  const out = { at: new Date().toISOString(), model: cfg.llm.model, items: items.slice(0, 12) };
  writeJson(path.join(P.work, 'supplements.json'), out);
  onEvent({ type: 'supplement-done', count: out.items.length });
  return out;
}

export function loadSupplements(projectId) {
  const P = projectPaths(projectId);
  const file = path.join(P.work, 'supplements.json');
  if (!fs.existsSync(file)) return { items: [] };
  const data = readJson(file) || { items: [] };
  // 历史版本生成的补充没有预排版的 HTML，读取时补上，
  // 这样旧任务不用重新生成也能正常显示公式（否则会看到 $z_0$ 这种源码）
  let patched = false;
  for (const it of data.items || []) {
    if (!it.shortHtml && it.short) {
      it.shortHtml = inlineMathHtml(it.short);
      patched = true;
    }
    if (!it.moreHtml && it.more) {
      it.moreHtml = mdToHtml(it.more).replace(/^<p>|<\/p>\s*$/g, '');
      patched = true;
    }
  }
  if (patched) {
    try {
      writeJson(file, data);
    } catch {}
  }
  return data;
}
