// 命令行入口：下载/安装运行所需的二进制与模型。
// 用法：
//   node app/fetch-tools.mjs --all
//   node app/fetch-tools.mjs ffmpeg sherpa asr-sensevoice
//   node app/fetch-tools.mjs --list
import { CATALOG, CORE_IDS, catalogStatus, installMany, install, statusOf } from './lib/download.mjs';
import { humanSize, ROOT, exists } from './lib/paths.mjs';
import { spawn } from 'node:child_process';
import path from 'node:path';

const argv = process.argv.slice(2);

/** 程序本身依赖 marked / katex（排版公式），换电脑后要先装好，否则起不来。 */
async function ensureNpmDeps() {
  const need = ['marked', 'katex'].filter((m) => !exists(path.join(ROOT, 'node_modules', m, 'package.json')));
  if (!need.length) return true;
  console.log(`首次运行需要安装排版依赖（${need.join('、')}）…`);
  const code = await new Promise((resolve) => {
    const p = spawn(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['install', '--omit=dev', '--no-audit', '--no-fund', '--loglevel=error'], {
      cwd: ROOT,
      stdio: 'inherit',
      windowsHide: true,
    });
    p.on('close', resolve);
    p.on('error', () => resolve(-1));
  });
  if (code !== 0) {
    console.error('依赖安装失败。请确认已安装 Node.js（https://nodejs.org），然后重新运行。');
    return false;
  }
  console.log('排版依赖安装完成。\n');
  return true;
}

function bar(p) {
  const total = p.total || 0;
  const pct = total ? Math.min(100, Math.floor((p.received / total) * 100)) : 0;
  const width = 28;
  let filled = total ? Math.round((width * p.received) / total) : 0;
  filled = Math.max(0, Math.min(width, filled)); // 防止越界导致 repeat 抛错
  return `[${'#'.repeat(filled)}${'.'.repeat(width - filled)}] ${String(pct).padStart(3)}%  ${humanSize(p.received)}${total ? ' / ' + humanSize(total) : ''}`;
}

if (argv.includes('--list')) {
  for (const s of catalogStatus()) {
    console.log(`${s.installed ? '[已安装]' : '[ 缺失 ]'} ${s.id.padEnd(20)} ${humanSize(s.size).padStart(9)}  ${s.label}`);
  }
  process.exit(0);
}

const ids = argv.includes('--all') || argv.length === 0 ? CORE_IDS : argv.filter((a) => !a.startsWith('--'));

if (!(await ensureNpmDeps())) process.exit(1);

let lastLine = '';
let lastPct = -10;
const onProgress = (p) => {
  const pct = p.total ? Math.floor((p.received / p.total) * 100) : 0;
  if (pct < lastPct + 5 && pct !== 100) return; // 每 5% 刷一次，避免刷屏
  lastPct = pct;
  const line = `${(CATALOG[p.id]?.label ?? p.id).slice(0, 18)}  ${bar(p)}`;
  if (line !== lastLine) {
    lastLine = line;
    process.stdout.write('\r' + line.padEnd(96));
  }
};

console.log(`准备安装 ${ids.length} 项资源：${ids.join(', ')}\n`);
const results = await installMany(ids, {
  onProgress,
  log: (m) => {
    process.stdout.write('\n' + m + '\n');
    lastLine = '';
  },
});

process.stdout.write('\n');
console.log('—'.repeat(60));
for (const r of results) {
  console.log(`${r.ok ? (r.skipped ? '跳过' : '完成') : '失败'}  ${r.id}${r.error ? '  ' + r.error : ''}`);
}
const bad = results.filter((r) => !r.ok);
console.log(bad.length ? `\n有 ${bad.length} 项失败，可重新运行本命令断点续传。` : '\n全部资源就绪。');
process.exit(bad.length ? 1 : 0);
