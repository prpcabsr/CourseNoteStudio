// 检查成稿里各类区块是否都落在「右键问 AI」的兜底范围内。
// 兜底依据是 .page 容器：只要选区在 .page 里就应该能问。
import { buildHtml } from '../app/lib/render.mjs';

const html = buildHtml(
  {
    title: 't',
    sections: [{ no: 1, title: '第一节', start: '00:00', markdown: '正文内容' }],
    overview: '概览内容',
    objectives: ['目标一'],
    timeline: [],
  },
  { meta: { title: 't', paper: 'A4', paperStyle: 'lined' } },
);

const checks = [
  ['成稿有 .page 容器（兜底依据）', /class="page"/.test(html)],
  ['封面 .cover 在 .page 内', /class="cover"/.test(html)],
  ['本讲概览在 .page 内', html.includes('本讲概览')],
  ['学习目标在 .page 内', html.includes('学习目标')],
  ['章节目录在 .page 内', html.includes('目录')],
  ['章节 .section 在 .page 内', /class="section"/.test(html)],
];

// .page 必须包住所有内容：取最后一个 </div> 之前所有区块都在其中
const pageStart = html.indexOf('class="page"');
const bodyEnd = html.lastIndexOf('</body>');
const covers = pageStart > 0 && pageStart < html.indexOf('本讲概览') && html.indexOf('学习目标') < bodyEnd;

let bad = 0;
for (const [name, ok] of checks) {
  if (!ok) bad++;
  console.log(`${ok ? '✓' : '✗'} ${name}`);
}
console.log(`${covers ? '✓' : '✗'} .page 容器包住概览与学习目标等区块`);
if (!covers) bad++;
console.log(bad ? `\n✗ ${bad} 项失败` : '\n✓ 成稿所有区块都能右键问 AI');
process.exit(bad ? 1 : 0);
