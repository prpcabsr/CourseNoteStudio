// 「整章做题技巧」的确定性部分：可勾选列表、历史记录、读取。
// 用法：node tests/summary-check.mjs
import fs from 'node:fs';
import { listPickable, listSummaries, loadSummary, generateSummary } from '../app/lib/summary.mjs';
import { listProjects } from '../app/lib/project.mjs';

let bad = 0;
const say = (ok, name) => {
  if (!ok) bad++;
  console.log(`${ok ? '✓' : '✗'} ${name}`);
};

// 1) 可勾选列表：每个任务带上它的章节
const projects = listProjects();
const pick = listPickable(projects);
say(Array.isArray(pick), '能列出可选任务');
say(
  pick.every((p) => Array.isArray(p.sections)),
  '每个任务都带章节列表',
);
const withSecs = pick.filter((p) => p.sections.length);
if (withSecs.length) {
  const p = withSecs[0];
  say(
    p.sections.every((s) => typeof s.index === 'number' && typeof s.title === 'string' && s.chars >= 0),
    `章节条目字段完整（示例：${p.sections[0].index + 1}. ${p.sections[0].title}）`,
  );
  say(
    !p.sections.some((s) => /\$/.test(s.title)),
    '章节标题里的公式定界符已经去掉（界面上不该出现 $）',
  );
} else {
  console.log('· 没有已完成的任务，跳过章节检查');
}

// 2) 不勾选任何节时必须报错，而不是发一次空请求
let threw = false;
try {
  await generateSummary({ picks: [] });
} catch {
  threw = true;
}
say(threw, '没勾选任何节时直接报错（不会白调模型）');

// 3) 历史总结列表 + 读取
const list = listSummaries();
say(Array.isArray(list), '能列出历史总结');
if (list.length) {
  say(
    list.every((s, i) => i === 0 || String(list[i - 1].at) >= String(s.at)),
    '历史总结按时间倒序',
  );
  const one = loadSummary(list[0].id);
  say(!!one && typeof one.markdown === 'string' && one.markdown.length > 50, '能读回总结正文');
  say(!!one.html && one.html.includes('<'), '总结带渲染好的 HTML');
  say(Array.isArray(one.sources) && one.sources.length > 0, '总结记下了来源（哪些任务、哪些节）');
  say(
    one.sources.every((s) => s.projectId && Array.isArray(s.sections)),
    '来源结构完整（任务 + 节）',
  );
  say(loadSummary('不存在的id') === null, '读不存在的总结返回 null');
} else {
  console.log('· 还没有历史总结，跳过这部分');
}

// 4) 目录形状：总结存到 data/summaries 下，属于用户数据（不进仓库）
say(!fs.existsSync('app/summaries'), '总结不会写进程序目录');
console.log(bad ? `\n✗ ${bad} 项失败` : '\n✓ 整章总结功能检查通过');
process.exit(bad ? 1 : 0);
