// 「整章做题技巧」总结。
//
// 和逐节笔记不一样：这里**故意不问概念**，只总结「怎么下手做题」——
// 什么条件配什么公式、几个公式怎么区分、容易在哪一步翻车。
// 因为一门课常常把一章拆成好几讲（甚至好几个视频），所以允许跨任务、跨节勾选。
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from './paths.mjs';
import { projectPaths } from './project.mjs';
import { loadConfig, resolveLlmKey } from './config.mjs';
import { callLlm } from './fusion.mjs';
import { mdToHtml } from './render.mjs';
import { readJson, writeJson } from './project.mjs';

const DIR = path.join(DATA_DIR, 'summaries');

const SYSTEM = `你是一位带过多届学生、非常擅长应试的大学理科老师。
学生会拿这份总结当「做题时的作战手册」，所以请把**概念定义、历史背景、证明细节全部略去**，
只留下**做题时真正用得上的东西**：

必须包含（按下面组织，能用表格就用表格）：
1. **看到什么条件 → 用哪个公式/方法**：把题型特征和对应工具一一对应地列出来。
   例如「被积函数是 $\dfrac{p(z)}{q(z)}$，$q$ 是二次多项式 → 先用判别式判断极点阶数，再用 $\operatorname{Res}=\dfrac{p(b)}{q'(b)}$」。
2. **几个相似公式怎么区分**：并排对比，重点写「什么情况下用 A、什么情况下用 B」，
   以及「用错会得到什么后果」。这是最容易混的地方，要写透。
3. **判断流程**：给一个可以直接照着走的步骤清单（编号），从读题到出结果。
4. **易错点与陷阱**：常见错法 + 正确做法，一行一条。
5. **典型题型的固定套路**：把材料里出现过的例题归纳成 2~4 类套路，每类给一个最短的解题骨架。

硬性要求：
- **不要写概念定义**（例如「洛朗级数是指……」），看到定义就删掉；
- 不要抄笔记原文，要**提炼成可操作的规则**；
- 材料里没有的内容不要编；
- 公式用 LaTeX（行内 $...$，独立 $$...$$）；
- 用 Markdown：## 分大块、表格、加粗关键词、编号清单；
- 开头用一句话说明这份总结覆盖了哪些内容（不要罗列太长）。`;

/** 把勾选的节拼成给模型的材料（带出处，便于它知道来自哪一讲）。 */
function buildMaterial(picks) {
  const parts = [];
  let n = 0;
  for (const p of picks) {
    for (const s of p.sections) {
      n++;
      parts.push(`──── 材料 ${n}｜来源：${p.title} · 第 ${s.index + 1} 节 ${s.title} ────`);
      parts.push(String(s.markdown || '').trim().slice(0, 12000));
      parts.push('');
    }
  }
  return parts.join('\n');
}

/**
 * @param {{picks: Array<{projectId:string,title:string,sections:Array<{index:number,title:string,markdown:string}>}>, cfg?:object, onEvent?:Function, signal?:AbortSignal}} args
 */
export async function generateSummary({ picks, cfg = loadConfig(), onEvent = () => {}, signal }) {
  if (!resolveLlmKey(cfg)) {
    throw new Error('没有可用的文本模型 Key，无法生成总结');
  }
  const flat = picks.flatMap((p) => p.sections.map((s) => ({ ...s, projectId: p.projectId, projectTitle: p.title })));
  if (!flat.length) throw new Error('至少要勾选一节笔记');
  const chars = flat.reduce((a, s) => a + String(s.markdown || '').length, 0);
  onEvent({ type: 'log', message: `整章总结：共 ${flat.length} 节、约 ${Math.round(chars / 1000)} 千字材料，开始提炼做题技巧…` });

  const { content } = await callLlm({
    cfg,
    messages: [
      { role: 'system', content: SYSTEM },
      { role: 'user', content: `下面是学生勾选的课堂笔记（可能来自同一章的不同讲次）。请提炼成一份**做题技巧手册**。\n\n${buildMaterial(picks)}` },
    ],
    onEvent,
    signal,
    temperature: 0.35,
  });
  const markdown = String(content || '').trim();
  if (markdown.length < 80) throw new Error('模型返回的内容太短，请重试');

  const id = `sum${Date.now().toString(36)}`;
  const out = {
    id,
    at: new Date().toISOString(),
    model: cfg?.llm?.model || '',
    sources: picks.map((p) => ({
      projectId: p.projectId,
      title: p.title,
      sections: p.sections.map((s) => `第 ${s.index + 1} 节 ${s.title}`),
    })),
    markdown,
    html: mdToHtml(markdown),
  };
  fs.mkdirSync(DIR, { recursive: true });
  writeJson(path.join(DIR, id + '.json'), out);
  onEvent({ type: 'log', level: 'ok', message: `整章总结完成：${markdown.length} 字，已保存` });
  return out;
}

/** 列出历史总结（新的在前，只带摘要）。 */
export function listSummaries() {
  if (!fs.existsSync(DIR)) return [];
  return fs
    .readdirSync(DIR)
    .filter((f) => f.endsWith('.json'))
    .map((f) => {
      const d = readJson(path.join(DIR, f));
      if (!d) return null;
      return {
        id: d.id,
        at: d.at,
        sources: d.sources || [],
        chars: String(d.markdown || '').length,
        firstLine: String(d.markdown || '').split('\n').find((l) => l.trim()) || '',
      };
    })
    .filter(Boolean)
    .sort((a, b) => String(b.at).localeCompare(String(a.at)));
}

export function loadSummary(id) {
  const safe = String(id || '').replace(/[^\w-]/g, '');
  const f = path.join(DIR, safe + '.json');
  if (!fs.existsSync(f)) return null;
  return readJson(f);
}

/** 列出所有任务 + 它们的章节，供界面勾选（跨任务挑节用）。 */
export function listPickable(projects) {
  return projects.map((p) => {
    const P = projectPaths(p.id);
    const doc = readJson(path.join(P.work, 'doc.json'));
    return {
      projectId: p.id,
      title: p.title || p.id,
      sections: (doc?.sections || []).map((s) => ({
        index: s.index,
        title: String(s.title || '').replace(/\$/g, ''),
        chars: String(s.markdown || '').length,
      })),
    };
  });
}
