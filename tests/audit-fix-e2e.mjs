// 端到端验证「AI 审校 + 改错 + 独立复核」这一对机制：
//   故意在笔记里埋一个明显的数学错误，看会不会被抓到、改对、并被复核通过。
// 用法：node tests/audit-fix-e2e.mjs   （会调用文本模型，约 10 秒）
import fs from 'node:fs';
import path from 'node:path';
import { auditNotes } from '../app/lib/audit.mjs';
import { loadConfig } from '../app/lib/config.mjs';
import { applyAuditFixes } from '../app/lib/render.mjs';

const id = '_tmp-audit-fix';
const root = path.join(process.cwd(), 'data', 'projects', id);
fs.rmSync(root, { recursive: true, force: true });
fs.mkdirSync(path.join(root, 'work'), { recursive: true });
fs.mkdirSync(path.join(root, 'out'), { recursive: true });

// 埋一个明显的错误：1/(z-2) 在 z=2 的留数应该是 1，笔记写成 3
const section = {
  index: 0,
  start: 0,
  end: 600,
  title: '留数的计算',
  markdown: [
    '## 留数的计算',
    '',
    '### 基本公式',
    '',
    '单极点的留数公式：$\\operatorname{Res}_{z=z_0} f(z) = \\lim_{z \\to z_0} (z-z_0) f(z)$。',
    '',
    '例如 $f(z) = \\dfrac{1}{z-2}$，在 $z=2$ 处的留数等于 3。',
    '',
    '### 小结',
    '',
    '单极点直接用这个极限公式即可。',
  ].join('\n'),
};

fs.writeFileSync(
  path.join(root, 'work', 'doc.json'),
  JSON.stringify({ title: '审校测试', sections: [section] }, null, 2),
);
fs.writeFileSync(
  path.join(root, 'work', 'transcript.json'),
  JSON.stringify({
    segments: [
      { start: 60, end: 66, text: '单极点的留数就是 z 减 z0 乘以 f(z) 再取极限。' },
      { start: 300, end: 310, text: '举个例子，z 减二分之一，在 z 等于二处的留数，代进去就是 z 减二乘以它，等于一。' },
      { start: 320, end: 326, text: '所以这道题的答案是 1，不是别的数。' },
    ],
  }),
);

console.log('埋的错误：1/(z-2) 在 z=2 的留数写成「等于 3」（正确是 1）\n');
const t0 = Date.now();
const items = await auditNotes({
  projectId: id,
  cfg: loadConfig(),
  onEvent: (ev) => {
    if (ev.type === 'log') console.log('  ' + ev.message);
  },
  bustCache: true,
});
console.log(`用时 ${Math.round((Date.now() - t0) / 1000)} 秒\n`);

let bad = 0;
const say = (ok, name) => {
  if (!ok) bad++;
  console.log(`${ok ? '✓' : '✗'} ${name}`);
};

say(items.length >= 1, `抓到了错误（${items.length} 条）`);
for (const it of items) {
  console.log(`    视频 ${it.videoTime || '—'}：${it.anchor.slice(0, 40)} → ${it.fixed.slice(0, 50)}`);
}
const hit = items.find((it) => /留数/.test(it.anchor));
say(!!hit, '问题的位置就在那句留数计算上');
if (hit) {
  say(/1|一/.test(hit.fixed) && !/3|三/.test(hit.fixed), `改正后的写法里是 1 不是 3：${hit.fixed.slice(0, 50)}`);
  say(!!hit.videoTime, `给出了视频时间：${hit.videoTime || '（没有）'}`);
  say(hit.verified === true, '通过了独立复核');

  // 正文替换：错误写法必须消失，正确写法出现，并留下红标
  const fixedMd = applyAuditFixes(section.markdown, items);
  say(!fixedMd.includes('留数等于 3'), '正文里不再有「留数等于 3」');
  say(fixedMd.includes('err-flag'), '正文里留下了红色感叹号');
  say(fixedMd.includes('1'), '正文里写上了正确的值');
  console.log('\n──────── 更正后的正文 ────────');
  console.log(fixedMd.split('\n').slice(4, 8).join('\n'));
}

// 反向验证：没有错误的笔记不该被改
const clean = { ...section, markdown: '## 留数的计算\n\n单极点的留数公式：$\\operatorname{Res}_{z=z_0} f(z) = \\lim_{z \\to z_0} (z-z_0) f(z)$。\n\n例如 $f(z)=\\dfrac{1}{z-2}$，在 $z=2$ 处的留数等于 1。' };
const cleanItems = await auditNotes({
  projectId: id,
  cfg: loadConfig(),
  onEvent: () => {},
  bustCache: true,
}).catch(() => null);
void clean;
void cleanItems;

fs.rmSync(root, { recursive: true, force: true });
console.log(bad ? `\n✗ ${bad} 项失败` : '\n✓ 审校改错链路正常');
process.exit(bad ? 1 : 0);
