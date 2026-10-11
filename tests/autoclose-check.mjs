// 验证「关掉所有页面后自动退出」是否真的生效。
// 用法：node tests/autoclose-check.mjs
// 注意：这里必须用原始 socket 模拟浏览器——用 fetch 的话连接会被放进连接池，
// 服务端看不到「关闭」这个动作，测不出真实行为。
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
// 用一个随机端口，避免以前遗留的浏览器标签页连进来干扰测试
const PORT = 18000 + Math.floor(Math.random() * 2000);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function alive() {
  try {
    const r = await fetch(`http://127.0.0.1:${PORT}/api/status`, { signal: AbortSignal.timeout(2000) });
    return r.ok;
  } catch {
    return false;
  }
}

async function life() {
  try {
    const r = await fetch(`http://127.0.0.1:${PORT}/api/life`, { signal: AbortSignal.timeout(2000) });
    return await r.json();
  } catch {
    return null;
  }
}

console.log('启动服务（端口 ' + PORT + '）…');
const srv = spawn('node', ['app/main.mjs', 'serve', '--port', String(PORT), '--open', 'false'], {
  cwd: ROOT,
  windowsHide: true,
});
let exitCode = null;
srv.on('exit', (c) => { exitCode = c ?? 0; });
let banner = '';
srv.stdout.on('data', (d) => {
  const text = d.toString();
  banner += text;
  for (const line of text.split('\n')) {
    if (line.trim()) console.log('  [服务] ' + line.trim());
  }
});
srv.stderr.on('data', (d) => {
  for (const line of d.toString().split('\n')) if (line.trim()) console.log('  [服务:err] ' + line.trim());
});

await wait(4000);
if (!(await alive())) { console.log('❌ 服务没起来'); srv.kill(); process.exit(1); }

console.log('模拟浏览器打开页面（原始 socket 请求 SSE）…');
const sock = net.connect(PORT, '127.0.0.1');
sock.on('error', () => {});
await new Promise((r) => sock.on('connect', r));
sock.write(`GET /api/events HTTP/1.1\r\nHost: 127.0.0.1:${PORT}\r\nAccept: text/event-stream\r\n\r\n`);
await wait(2000);
console.log('  连接状态：' + JSON.stringify(await life()));
console.log('✓ 页面已连上；等 8 秒确认有页面时不会误退…');
await wait(8000);
if (exitCode !== null) { console.log('❌ 有页面连着却退出了'); process.exit(1); }
console.log('✓ 有页面时保持运行');

console.log('模拟关闭页面（直接断开 socket）…');
sock.destroy();
const t0 = Date.now();
let ok = false;
for (let i = 0; i < 25; i++) {
  await wait(3000);
  if (exitCode !== null) { ok = true; break; }
  const st = await life();
  process.stdout.write(`  等待自动退出… ${Math.round((Date.now() - t0) / 1000)}s  ${st ? JSON.stringify(st) : '(服务已不可达)'}\n`);
}
if (ok) {
  console.log(`✅ 所有页面关闭后自动退出（约 ${Math.round((Date.now() - t0) / 1000)} 秒后退出，退出码 ${exitCode}）`);
} else {
  console.log('❌ 超时仍未退出');
  srv.kill();
}
process.exit(ok ? 0 : 1);
