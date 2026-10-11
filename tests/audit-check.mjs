// 检查 AI 审校的「改错 + 红标」有没有正确落进成稿。
// 用法：node tests/audit-check.mjs [projectId]
import fs from 'node:fs';
import path from 'node:path';
import { applyAuditFixes } from '../app/lib/render.mjs';
import { locateInMarkdown } from '../app/lib/audit.mjs';

const id = process.argv[2] || 'pmv3juxzob133';
const htmlFile = path.join(process.cwd(), 'data', 'projects', id, 'out', 'notes.html');
const auditFile = path.join(process.cwd(), 'data', 'projects', id, 'work', 'audit.json');

let bad = 0;
const say = (ok, name) => {
  if (!ok) bad++;
  console.log(`${ok ? '✓' : '✗'} ${name}`);
};

// 1) 替换逻辑：正文里必须只剩正确写法，并留下红标
const md = '例如 f(z)=1/(z-2)，在 z=2 处的留数等于 3。后面继续。';
const items = [{ anchor: '例如 f(z)=1/(z-2)，在 z=2 处的留数等于 3', fixed: '例如 f(z)=1/(z-2)，在 z=2 处的留数等于 1', title: '算错了', videoTime: '05:00' }];
const out = applyAuditFixes(md, items);
say(out.includes('留数等于 1'), '正文换成了正确写法');
say(!out.includes('留数等于 3'), '正文里不再有错误写法');
say(out.includes('class="err-flag"'), '改过的地方留下红色感叹号');
say(out.includes('05:00'), '红标提示里带上了视频时间');
say(out.includes('后面继续。'), '正文其余部分不受影响');
say(applyAuditFixes(md, []).length === md.length, '没有问题时一个字都不改');
say(!applyAuditFixes(md, [{ anchor: '根本不在原文里的一句话', fixed: 'x' }]).includes('err-flag'), '锚点对不上时不乱改');
// 没有 fixed 的（旧的审校数据）不应该改动正文
say(applyAuditFixes(md, [{ anchor: '留数等于 3', title: '旧数据没有 fixed' }]).includes('留数等于 3'), '旧数据（没有 fixed）不会误改');

// 2) 定位逻辑
const md2 = '设 b 为本性奇点，将 f(z) 以 b 为中心作罗朗展开。';
say(locateInMarkdown(md2, '设b为本性奇点') === '设 b 为本性奇点', '忽略空白也能定位，且切出的片段逐字在原文里');
say(locateInMarkdown(md2, '完全不存在') === null, '对不上返回 null');

// 3) 实际成稿
if (fs.existsSync(htmlFile)) {
  const html = fs.readFileSync(htmlFile, 'utf8');
  const flags = (html.match(/class="err-flag"/g) || []).length;
  const list = fs.existsSync(auditFile) ? JSON.parse(fs.readFileSync(auditFile, 'utf8')).items || [] : [];
  const inner = (html.match(/err-flag/g) || []).length;
  say(inner >= list.length, `成稿里的红标数（${inner}）不少于审校条数（${list.length}）`);
  if (list.length) {
    say(html.includes('AI 审校按视频更正过的地方'), '成稿带「按视频更正过的地方」附录');
    // 错误写法不该出现在正文里
    let leaked = 0;
    for (const it of list) {
      const body = html.slice(0, html.indexOf('<section class="appendix"'));
      if (it.anchor && body.includes(it.anchor)) leaked++;
    }
    say(leaked === 0, `正文里没有残留任何被更正的错误写法（残留 ${leaked} 处）`);
    say(
      list.every((it) => it.verified === true),
      '所有改动都经过独立复核（verified）',
    );
    // 说明里的公式必须已经排版好（界面上不能出现 $z_1+z_2=-1$ 这种源码）
    const raw = list.filter((it) => /\$[a-zA-Z\\]/.test(String(it.detailHtml || '').replace(/<[^>]+>/g, '')));
    say(raw.length === 0, `审校说明里的公式都已排版（裸公式 ${raw.length} 条）`);
    say(list.every((it) => !it.detail || !it.detailHtml || it.detailHtml.includes('katex') || !/\$/.test(it.detail)), '有公式的说明都生成了 HTML');
  } else {
    console.log('· 这份成稿没有审校问题');
  }
  void flags;
} else {
  console.log(`· 跳过成稿检查（找不到 ${htmlFile}）`);
}

console.log(bad ? `\n✗ ${bad} 项失败` : '\n✓ AI 审校改错与红标全部正确');
process.exit(bad ? 1 : 0);
