// 检查 AI 审校的红标有没有正确烧进成稿。
// 用法：node tests/audit-check.mjs [projectId]
import fs from 'node:fs';
import path from 'node:path';
import { injectAuditFlags } from '../app/lib/render.mjs';
import { locateInMarkdown } from '../app/lib/audit.mjs';

const id = process.argv[2] || 'pmv3juxzob133';
const htmlFile = path.join(process.cwd(), 'data', 'projects', id, 'out', 'notes.html');
const auditFile = path.join(process.cwd(), 'data', 'projects', id, 'work', 'audit.json');

let bad = 0;
const say = (ok, name) => {
  if (!ok) bad++;
  console.log(`${ok ? '✓' : '✗'} ${name}`);
};

// 1) 注入逻辑本身
const md = '设 b 为本性奇点，把只对单极点成立的公式当成通用公式使用。后面继续。';
const out = injectAuditFlags(md, [{ anchor: '把只对单极点成立的公式当成通用公式使用', title: '公式用错了' }]);
say(out.includes('class="err-flag"'), '红标能插到锚点后面');
say(out.includes('后面继续。'), '正文其余部分不受影响');
say(injectAuditFlags(md, []).length === md.length, '没有问题时一个字都不改');
say(
  !injectAuditFlags(md, [{ anchor: '这句话根本不在原文里', title: 'x' }]).includes('err-flag'),
  '锚点对不上时不乱标',
);

// 2) 定位逻辑
const md2 = '设 b 为本性奇点，将 f(z) 以 b 为中心作罗朗展开。';
say(locateInMarkdown(md2, '设b为本性奇点') === '设 b 为本性奇点', '忽略空白也能定位，且切出的片段逐字在原文里');
say(locateInMarkdown(md2, '罗朗展开') === '罗朗展开', '短锚点可定位');
say(locateInMarkdown(md2, '完全不存在') === null, '对不上返回 null');

// 3) 实际成稿
if (fs.existsSync(htmlFile)) {
  const html = fs.readFileSync(htmlFile, 'utf8');
  const flags = (html.match(/class="err-flag"/g) || []).length;
  const items = fs.existsSync(auditFile) ? JSON.parse(fs.readFileSync(auditFile, 'utf8')).items || [] : [];
  // 每条问题会出现两次红标：正文里那一个 + 附录卡片标题那一个
  say(flags === items.length * 2, `成稿里的红标数（${flags}）＝ 问题数（${items.length}）× 2（正文 + 附录各一个）`);
  if (items.length) {
    say(html.includes('AI 审校发现的问题'), '成稿带「AI 审校发现的问题」附录');
    say(html.includes('err-flag'), '成稿里有红色感叹号（关掉 AI 批注也看得见）');
  }
} else {
  console.log(`· 跳过成稿检查（找不到 ${htmlFile}）`);
}

console.log(bad ? `\n✗ ${bad} 项失败` : '\n✓ AI 审校红标全部正确');
process.exit(bad ? 1 : 0);
