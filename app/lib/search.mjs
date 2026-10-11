// 全库检索：在所有任务的笔记 + 转写稿 + 板书识别结果里找内容。
//
// 两种模式：
//   exact —— 原文匹配（原话、术语、公式直接搜出来）
//   ai    —— 语义搜索：先本地粗排候选，再让文本模型判断哪些片段真正命中，
//            适合「不记得原话，只记得大概意思」的情况
import fs from 'node:fs';
import path from 'node:path';
import { projectPaths, listProjects, readJson } from './project.mjs';
import { callLlm } from './fusion.mjs';
import { repairLatex } from './latex.mjs';
import { parseLlmJson } from './json.mjs';

const MAX_CHUNK = 700; // 单个片段送去 AI 判定的最大长度

function hhmmss(sec) {
  const s = Math.max(0, Math.floor(sec || 0));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = s % 60;
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(ss).padStart(2, '0')}` : `${String(m).padStart(2, '0')}:${String(ss).padStart(2, '0')}`;
}

/** 把一段长文本切成便于检索的小块（按空行分段）。 */
function splitParagraphs(text) {
  return String(text || '')
    .split(/\n\s*\n/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/** 读出一个任务的全部可检索内容。缓存按文件 mtime 失效。 */
const cache = new Map();

function fileStamp(files) {
  return files.map((f) => {
    try {
      return fs.statSync(f).mtimeMs;
    } catch {
      return 0;
    }
  }).join('-');
}

export function loadChunks(projectId, { useCache = true } = {}) {
  const P = projectPaths(projectId);
  const docPath = path.join(P.work, 'doc.json');
  const trPath = path.join(P.work, 'transcript.json');
  const snapPath = path.join(P.work, 'snapshots.json');
  const stamp = fileStamp([docPath, trPath, snapPath]);
  const hit = cache.get(projectId);
  if (useCache && hit && hit.stamp === stamp) return hit.chunks;

  const state = readJson(P.state) || {};
  const ptitle = state.title || '未命名任务';
  const doc = readJson(docPath);
  const tr = readJson(trPath);
  const snaps = readJson(snapPath);
  const chunks = [];
  const push = (kind, label, t, text) => {
    const clean = String(text || '').replace(/\s+/g, ' ').trim();
    if (clean.length < 2) return;
    chunks.push({ pid: projectId, ptitle, kind, label, t: t ?? null, time: t != null ? hhmmss(t) : '', text: clean });
  };

  if (doc) {
    if (doc.overview) push('overview', '本讲概览', null, doc.overview);
    (doc.objectives || []).forEach((o, i) => push('objective', `学习目标 ${i + 1}`, null, o));
    (doc.sections || []).forEach((s) => {
      const label = `第 ${(s.index ?? 0) + 1} 节 · ${s.title || ''}`;
      for (const para of splitParagraphs(s.markdown || '')) {
        if (/^#{1,4}\s/.test(para) && para.length < 80) continue; // 纯标题不单独成块
        push('section', label, s.start, para);
      }
    });
    if (doc.formulas) for (const line of splitParagraphs(doc.formulas)) push('formulas', '关键公式', null, line);
    if (doc.glossary) for (const line of splitParagraphs(doc.glossary)) push('glossary', '术语表', null, line);
    if (doc.quiz) for (const line of splitParagraphs(doc.quiz)) push('quiz', '复习自测', null, line);
  }
  for (const seg of tr?.segments || []) {
    push('transcript', '课堂讲稿', seg.start, seg.text);
  }
  for (const s of snaps || []) {
    if (s.dup) continue;
    const text = [s.ocr?.title, s.ocr?.text].filter(Boolean).join(' ');
    push('board', `板书 · 第 ${(s.generation ?? 0) + 1} 块`, s.t, text);
  }

  cache.set(projectId, { stamp, chunks });
  return chunks;
}

export function loadAllChunks() {
  const out = [];
  for (const p of listProjects()) {
    try {
      out.push(...loadChunks(p.id));
    } catch {
      /* 某个任务坏了不影响其它 */
    }
  }
  return out;
}

/** 全角/半角、大小写归一，方便「原话」检索。 */
function norm(s) {
  return String(s || '')
    .replace(/[\uff01-\uff5e]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
    .replace(/\u3000/g, ' ')
    .toLowerCase();
}

/**
 * 片段可能正好切在 $...$ 中间，那样末尾会漏出半截 LaTeX 源码。
 * 这里把落单的 $ 之后的部分去掉，保证给到前端的片段里公式都是成对的。
 */
function balanceMath(s) {
  const text = String(s);
  const n = (text.match(/\$/g) || []).length;
  if (n % 2 === 0) return text;
  const i = text.lastIndexOf('$');
  if (i <= 0) return text.replace(/\$/g, '');
  return text.slice(0, i).trimEnd() + '…';
}

function makeSnippet(text, idx, len) {
  const pad = 42;
  const from = Math.max(0, idx - pad);
  const to = Math.min(text.length, idx + len + pad);
  return balanceMath((from > 0 ? '…' : '') + text.slice(from, to) + (to < text.length ? '…' : ''));
}

/** 原文匹配：支持多个关键词（空格分开，全部命中才算）与整句短语。 */
export function searchExact(query, { limit = 80 } = {}) {
  const q = String(query || '').trim();
  if (!q) return { hits: [], total: 0 };
  const terms = q.split(/\s+/).filter(Boolean).map(norm);
  const hits = [];
  for (const c of loadAllChunks()) {
    const hay = norm(c.text);
    let ok = true;
    let firstIdx = -1;
    for (const t of terms) {
      const i = hay.indexOf(t);
      if (i < 0) {
        ok = false;
        break;
      }
      if (firstIdx < 0 || i < firstIdx) firstIdx = i;
    }
    if (!ok) continue;
    hits.push({
      pid: c.pid,
      ptitle: c.ptitle,
      kind: c.kind,
      label: c.label,
      t: c.t,
      time: c.time,
      snippet: makeSnippet(c.text, firstIdx, terms[0].length),
      score: terms.length * 2 + (hay.includes(norm(q)) ? 3 : 0), // 整句命中排更前
    });
  }
  hits.sort((a, b) => b.score - a.score || (a.t ?? 0) - (b.t ?? 0));
  return { hits: hits.slice(0, limit), total: hits.length };
}

/** 中文按二元组切词，做本地粗排（决定送哪些片段给 AI）。 */
function bigrams(s) {
  const t = norm(s).replace(/[^\p{L}\p{N}]+/gu, '');
  const out = [];
  for (let i = 0; i + 2 <= t.length; i++) out.push(t.slice(i, i + 2));
  if (!out.length && t) out.push(t);
  return out;
}

export function rankCandidates(query, chunks, n = 14) {
  const qb = bigrams(query);
  const qn = norm(query);
  const scored = chunks.map((c) => {
    const hay = norm(c.text);
    const cb = new Set(bigrams(c.text));
    let overlap = 0;
    for (const g of qb) if (cb.has(g)) overlap++;
    let score = qb.length ? overlap / qb.length : 0;
    if (qn && hay.includes(qn)) score += 1.5; // 整句命中直接大幅加分
    // 术语类片段（公式/板书）等同义信息密度更高，略微加权
    if (c.kind === 'formulas' || c.kind === 'board' || c.kind === 'glossary') score += 0.03;
    return { c, score };
  });
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, n).map((x) => x.c);
}

const AI_SYSTEM = `你是一个课程笔记检索助手。用户会给你一个检索意图（可能记得不清楚、甚至是大概意思），以及若干条候选片段。
你的任务：挑出**真正符合用户意图**的片段。

要求：
1. 不要求字面一致，只要内容上确实相关或能回答用户想找的东西，就算命中。
2. 宁可少而准：只有明显相关的才选，不要为了凑数把沾边的都选上。
3. 如果用户其实是在问一个问题，就顺便用一两句话回答它。
4. 严格输出 JSON，不要加任何解释文字：
{"hits":[{"i":候选编号,"why":"一句话说明这里为什么相关"}],"answer":"回答（没有就填空字符串）"}`;

/** 语义搜索：本地粗排 + 文本模型判定。 */
export async function searchAi({ query, cfg, limit = 14, onEvent = () => {} }) {
  const q = String(query || '').trim();
  if (!q) return { hits: [], answer: '', candidates: 0 };
  const all = loadAllChunks();
  const cands = rankCandidates(q, all, limit);
  if (!cands.length) return { hits: [], answer: '', candidates: 0 };

  const list = cands
    .map((c, i) => `[${i}] 任务《${c.ptitle}》 ${c.label}${c.time ? ' @' + c.time : ''}\n${c.text.slice(0, MAX_CHUNK)}`)
    .join('\n\n');
  const user = `检索意图：${q}\n\n候选片段：\n${list}`;
  onEvent({ type: 'search-ai-start', candidates: cands.length });
  const { content } = await callLlm({
    cfg,
    messages: [
      { role: 'system', content: AI_SYSTEM },
      { role: 'user', content: user },
    ],
    json: true,
  });
  let parsed;
  try {
    parsed = parseLlmJson(content, 'AI 搜索结果');
  } catch {
    parsed = { hits: [] };
  }
  const hits = [];
  for (const h of parsed.hits || []) {
    const c = cands[Number(h.i)];
    if (!c) continue;
    hits.push({
      pid: c.pid,
      ptitle: c.ptitle,
      kind: c.kind,
      label: c.label,
      t: c.t,
      time: c.time,
      snippet: balanceMath(c.text.length > 320 ? c.text.slice(0, 320) + '…' : c.text),
      why: String(h.why || ''),
      score: 1,
    });
  }
  return { hits, answer: String(parsed.answer || ''), candidates: cands.length };
}

/** 清掉缓存（任务被删/重新生成后用）。 */
export function invalidateSearchCache(projectId) {
  if (projectId) cache.delete(projectId);
  else cache.clear();
}
