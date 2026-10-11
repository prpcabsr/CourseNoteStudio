// 子进程与 ffmpeg 封装。
import { spawn } from 'node:child_process';
import { findFfmpeg, findFfprobe, findYtDlp, findLlamaServer, findSherpaCli, exists, toolPath } from './paths.mjs';

export function run(cmd, args, opts = {}) {
  const { cwd, onLine, onStdout, signal, encoding = 'utf8', timeoutMs } = opts;
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(cmd, args, { cwd, windowsHide: true, signal });
    } catch (e) {
      reject(e);
      return;
    }
    let stdout = '';
    let stderr = '';
    let timer = null;
    if (timeoutMs) {
      timer = setTimeout(() => {
        try {
          child.kill();
        } catch {}
        reject(new Error(`${cmd} 超时（${Math.round(timeoutMs / 1000)}s）`));
      }, timeoutMs);
    }
    const bufOut = [];
    child.stdout.on('data', (d) => {
      const s = d.toString(encoding);
      stdout += s;
      if (stdout.length > 4_000_000) stdout = stdout.slice(-1_000_000);
      bufOut.push(s);
      if (onStdout) onStdout(s);
      if (onLine) splitLines(bufOut, onLine);
    });
    child.stderr.on('data', (d) => {
      const s = d.toString(encoding);
      stderr += s;
      if (stderr.length > 1_000_000) stderr = stderr.slice(-400_000);
      if (onLine) onLine(s, true);
    });
    child.on('error', (e) => {
      if (timer) clearTimeout(timer);
      reject(e);
    });
    child.on('close', (code) => {
      if (timer) clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

function splitLines(buf, onLine) {
  const joined = buf.join('');
  buf.length = 0;
  const lines = joined.split(/\r?\n/);
  const rest = lines.pop() ?? '';
  if (rest) buf.push(rest);
  for (const l of lines) if (l.trim()) onLine(l, false);
}

/** 需要拿到原始二进制流时使用（例如 ffmpeg 输出 rawvideo）。 */
export function runBinary(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { windowsHide: true, signal: opts.signal });
    let stderr = '';
    child.stderr.on('data', (d) => {
      stderr += d.toString();
      if (stderr.length > 500_000) stderr = stderr.slice(-200_000);
    });
    child.on('error', reject);
    resolve({ child, stderrRef: () => stderr });
  });
}

export const ffmpeg = {
  bin: () => findFfmpeg(),
  available: () => exists(toolPath('ffmpeg', 'bin', 'ffmpeg.exe')) || whichOk('ffmpeg.exe'),
};

function whichOk() {
  return false; // 子进程内不做 PATH 探测，交给外层状态检查
}

export function ffprobeJson(file) {
  return run(findFfprobe(), [
    '-v',
    'error',
    '-print_format',
    'json',
    '-show_format',
    '-show_streams',
    file,
  ]).then((r) => JSON.parse(r.stdout));
}

/** 用 ffmpeg 在指定时间点导出单帧图片。 */
export async function grabFrame(src, seconds, outPath, { width, crop } = {}) {
  const filters = [];
  if (crop) filters.push(`crop=${crop.w}:${crop.h}:${crop.x}:${crop.y}`);
  if (width) filters.push(`scale=${width}:-2`);
  // mjpeg 编码器要求全范围 YUV，否则会报 "Non full-range YUV is non-standard" 直接失败
  filters.push('format=yuvj420p');
  const args = [
    '-hide_banner', '-loglevel', 'error', '-nostdin',
    '-ss', String(Math.max(0, seconds)),
    '-i', src,
    '-frames:v', '1',
    '-vf', filters.join(','),
    '-strict', 'unofficial',
    '-q:v', '2',
    '-y', outPath,
  ];
  const r = await run(ffmpeg.bin(), args, { timeoutMs: 120000 });
  if (r.code !== 0) throw new Error(`抽帧失败 @${seconds}s: ${r.stderr.slice(0, 300)}`);
  return outPath;
}

export { findYtDlp, findLlamaServer, findSherpaCli, findFfmpeg, findFfprobe, exists, toolPath };
