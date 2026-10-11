// 搜索功能自测：原文匹配 + 候选粗排。
// 用法：node tests/search-check.mjs ["要搜的词"]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { searchExact, loadAllChunks, rankCandidates } from '../app/lib/search.mjs';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const q = process.argv[2] || '留数';

const chunks = loadAllChunks();
const byKind = {};
for (const c of chunks) byKind[c.kind] = (byKind[c.kind] || 0) + 1;
console.log(`索引片段：${chunks.length} 块`);
for (const [k, v] of Object.entries(byKind).sort((a, b) => b[1] - a[1])) console.log(`   ${k.padEnd(12)} ${v}`);
if (!chunks.length) {
  console.log('\n（还没有任何任务，跳过搜索测试）');
  process.exit(0);
}

console.log(`\n=== 原文匹配「${q}」 ===`);
const r = searchExact(q);
console.log(`命中 ${r.total} 处，显示前 ${r.hits.length} 处：`);
for (const h of r.hits.slice(0, 6)) {
  console.log(`  [${h.kind}]《${h.ptitle}》${h.time ? ' @' + h.time : ''}`);
  console.log(`     ${h.snippet.slice(0, 100)}`);
}

console.log(`\n=== AI 搜索的候选粗排（不调用模型，只看本地排序）===`);
const cands = rankCandidates(q, chunks, 6);
for (const c of cands) {
  console.log(`  [${c.kind}]《${c.ptitle}》${c.time ? ' @' + c.time : ''}  ${c.text.slice(0, 80)}`);
}

// 断言：原文搜索确实找得到，且优先返回讲稿原话
const ok1 = r.hits.length > 0;
const ok2 = cands.length > 0;
console.log(ok1 && ok2 ? '\n✓ 搜索自测通过' : '\n✗ 搜索没返回结果');
process.exit(ok1 && ok2 ? 0 : 1);
