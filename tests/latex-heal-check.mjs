// 自愈测试：把之前被插错 $ 的损坏文本喂进去，看能不能恢复成正确公式。
import { repairLatex } from '../app/lib/latex.mjs';

const CASES = [
  [
    '5. 计算 $∮_{$|z|$=1} dz/(z$$^{2}+2z+ε)$，其中 $0<ε<1$。',
    '5. 计算 $∮_{|z|=1} dz/(z^{2}+2z+ε)$，其中 $0<ε<1$。',
  ],
  [
    '简答要点：$\\operatorname{Res} = 1/2! · \\lim_{z→a} d$$^{2}/dz^{2}$$(z e^z) = 1/2 · (a+2)e^a$。',
    '简答要点：$\\operatorname{Res} = 1/2! · \\lim_{z→a} d^{2}/dz^{2}(z e^z) = 1/2 · (a+2)e^a$。',
  ],
];

let bad = 0;
for (const [broken, want] of CASES) {
  const out = repairLatex(broken);
  const ok = out === want;
  if (!ok) bad++;
  console.log((ok ? '✓' : '✗') + ' ' + broken);
  if (!ok) {
    console.log('   得到：' + out);
    console.log('   期望：' + want);
  }
}
console.log(bad ? `\n✗ ${bad} 条没恢复` : '\n✓ 自愈全部通过');
process.exit(bad ? 1 : 0);
