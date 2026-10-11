// 验证板书 JSON 解析的健壮性（本地小模型经常输出带裸换行的 JSON）。
import { parseBoardJson } from '../app/lib/vision.mjs';

const cases = [
  ['标准 JSON', '{"scene":"board","title":"相位传播","text":"第一行","layout":"左右分栏","confidence":"high"}'],
  ['裸换行', '{"scene": "board|slide", "title": "波速", "text": "第一行\n第二行\n第三行", "layout": "左右", "confidence": "high"}'],
  ['代码块包裹', '```json\n{"scene":"board","text":"甲","title":"题","layout":"","confidence":"high"}\n```'],
  ['前言+JSON', '好的，识别结果如下：\n{"scene":"board","text":"内容","title":"标题","layout":"","confidence":"medium"}'],
  ['文本里带引号', '{"scene":"board","text":"他说"连续"的意思","title":"t","layout":"","confidence":"high"}'],
  ['纯文本', '黑板上写着：一、机械波'],
];

for (const [name, input] of cases) {
  const r = parseBoardJson(input);
  const okText = r.text && !r.text.trim().startsWith('{');
  console.log(`${okText ? '✓' : '✗'} ${name.padEnd(10)} scene=${r.scene} title=${r.title} text=${JSON.stringify(r.text).slice(0, 60)}${r.repaired ? ' [已修复]' : ''}${r.degraded ? ' [降级]' : ''}`);
}
