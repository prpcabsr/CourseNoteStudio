// 资源下载与安装：ffmpeg / yt-dlp / llama.cpp / sherpa-onnx / 各类模型。
// 设计目标：断点续传、镜像回退、进度回调、可被 UI 一键调用。
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { TOOLS_DIR, MODELS_DIR } from './paths.mjs';
import { humanSize } from './paths.mjs';

const HF = 'https://hf-mirror.com';
const GH = 'https://github.com';

/** 每个条目：{ label, kind, size, urls[], dest, ... } */
export const CATALOG = {
  ytdlp: {
    label: 'yt-dlp（视频下载器）',
    kind: 'file',
    size: 17_800_000,
    dest: path.join(TOOLS_DIR, 'yt-dlp.exe'),
    urls: [`${GH}/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe`],
    note: '支持 B 站 / YouTube / 慕课等上千个站点',
  },
  ffmpeg: {
    label: 'FFmpeg（音视频解码）',
    kind: 'archive',
    size: 193_037_122,
    dest: path.join(TOOLS_DIR, 'ffmpeg'),
    urls: [`${GH}/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-n8.1-latest-win64-gpl-8.1.zip`],
    normalize: normalizeFfmpeg,
    note: '抽帧、抽音轨、切片',
  },
  'llamacpp-vulkan': {
    label: 'llama.cpp Vulkan 版（视觉模型推理引擎）',
    kind: 'archive',
    size: 33_464_528,
    dest: path.join(TOOLS_DIR, 'llamacpp-vulkan'),
    urls: [`${GH}/ggml-org/llama.cpp/releases/download/b11541/llama-b11541-bin-win-vulkan-x64.zip`],
    note: '使用显卡加速识别板书',
  },
  'llamacpp-cpu': {
    label: 'llama.cpp CPU 版（备用推理引擎）',
    kind: 'archive',
    size: 19_518_702,
    dest: path.join(TOOLS_DIR, 'llamacpp-cpu'),
    urls: [`${GH}/ggml-org/llama.cpp/releases/download/b11541/llama-b11541-bin-win-cpu-x64.zip`],
    note: '显卡不可用时的兜底方案',
  },
  sherpa: {
    label: 'sherpa-onnx（语音识别引擎）',
    kind: 'archive',
    size: 24_805_859,
    dest: path.join(TOOLS_DIR, 'sherpa'),
    urls: [`${GH}/k2-fsa/sherpa-onnx/releases/download/v1.13.8/sherpa-onnx-v1.13.8-win-x64-shared-MT-Release.tar.bz2`],
    normalize: normalizeSherpa,
    note: '把讲课语音转成带时间戳的文字',
  },
  'asr-sensevoice': {
    label: 'SenseVoice 语音识别模型（中英日韩粤）',
    kind: 'files',
    size: 237_120_000,
    dest: path.join(MODELS_DIR, 'asr', 'sensevoice'),
    files: [
      { url: `${HF}/csukuangfj/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-int8-2025-09-09/resolve/main/model.int8.onnx`, name: 'model.int8.onnx', size: 237115547 },
      { url: `${HF}/csukuangfj/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-int8-2025-09-09/resolve/main/tokens.txt`, name: 'tokens.txt', size: 200000 },
    ],
    note: '中文课堂识别又快又准',
  },
  'asr-vad': {
    label: '语音活动检测模型（切分句子）',
    kind: 'file',
    size: 2_200_000,
    minSize: 500_000,
    dest: path.join(MODELS_DIR, 'asr', 'vad', 'silero_vad.onnx'),
    urls: [`${GH}/k2-fsa/sherpa-onnx/releases/download/asr-models/silero_vad.onnx`],
    note: '让讲稿按自然句子切分，时间戳更准',
  },
  'asr-punct': {
    label: '标点恢复模型',
    kind: 'archive',
    size: 279_028_058,
    dest: path.join(MODELS_DIR, 'asr', 'punct'),
    urls: [`${GH}/k2-fsa/sherpa-onnx/releases/download/punctuation-models/sherpa-onnx-punct-ct-transformer-zh-en-vocab272727-2024-04-12.tar.bz2`],
    normalize: normalizePunct,
    note: '给识别结果补上逗号句号，笔记更通顺',
  },
  'vlm-qwen3vl-4b': {
    label: 'Qwen3-VL-4B 视觉模型（推荐，看板书）',
    kind: 'files',
    size: 2_830_000_000,
    dest: path.join(MODELS_DIR, 'vlm', 'qwen3-vl-4b'),
    files: [
      { url: `${HF}/Qwen/Qwen3-VL-4B-Instruct-GGUF/resolve/main/Qwen3VL-4B-Instruct-Q4_K_M.gguf`, name: 'Qwen3VL-4B-Instruct-Q4_K_M.gguf', size: 2497281664 },
      { url: `${HF}/Qwen/Qwen3-VL-4B-Instruct-GGUF/resolve/main/mmproj-Qwen3VL-4B-Instruct-Q8_0.gguf`, name: 'mmproj-Qwen3VL-4B-Instruct-Q8_0.gguf', size: 453_000_000 },
    ],
    note: '手写板书、公式、中文识别效果最好',
  },
  'vlm-qwen25vl-3b': {
    label: 'Qwen2.5-VL-3B 视觉模型（轻量，省显存）',
    kind: 'files',
    size: 2_650_000_000,
    dest: path.join(MODELS_DIR, 'vlm', 'qwen25-vl-3b'),
    files: [
      { url: `${HF}/ggml-org/Qwen2.5-VL-3B-Instruct-GGUF/resolve/main/Qwen2.5-VL-3B-Instruct-Q4_K_M.gguf`, name: 'Qwen2.5-VL-3B-Instruct-Q4_K_M.gguf', size: 1840000000 },
      { url: `${HF}/ggml-org/Qwen2.5-VL-3B-Instruct-GGUF/resolve/main/mmproj-Qwen2.5-VL-3B-Instruct-Q8_0.gguf`, name: 'mmproj-Qwen2.5-VL-3B-Instruct-Q8_0.gguf', size: 806000000 },
    ],
    note: '体积更小，识别速度更快',
  },
};

/** 推荐首次安装的集合（不含可选大模型）。 */
export const CORE_IDS = ['ytdlp', 'ffmpeg', 'llamacpp-vulkan', 'sherpa', 'asr-sensevoice', 'asr-vad', 'asr-punct', 'vlm-qwen3vl-4b'];
export const DEFAULT_VLM = 'vlm-qwen3vl-4b';

// ---------------------------------------------------------------- 安装状态

function findFile(dir, name, depth = 3) {
  if (depth < 0) return null;
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return null;
  }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isFile() && e.name.toLowerCase() === name.toLowerCase()) return p;
  }
  for (const e of entries) {
    if (e.isDirectory()) {
      const r = findFile(path.join(dir, e.name), name, depth - 1);
      if (r) return r;
    }
  }
  return null;
}

function moveInto(from, to) {
  fs.mkdirSync(path.dirname(to), { recursive: true });
  try {
    fs.rmSync(to, { force: true, recursive: false });
  } catch {}
  fs.renameSync(from, to);
}

function normalizeFfmpeg(dir) {
  const exe = findFile(dir, 'ffmpeg.exe', 4);
  if (!exe) throw new Error('压缩包中未找到 ffmpeg.exe');
  const binDir = path.dirname(exe);
  const target = path.join(dir, 'bin');
  fs.mkdirSync(target, { recursive: true });
  for (const f of fs.readdirSync(binDir)) {
    if (/\.(exe|dll)$/i.test(f)) moveInto(path.join(binDir, f), path.join(target, f));
  }
}

function normalizeSherpa(dir) {
  const exe = findFile(dir, 'sherpa-onnx-offline.exe', 4);
  if (!exe) throw new Error('压缩包中未找到 sherpa-onnx-offline.exe');
  const binDir = path.dirname(exe);
  const target = path.join(dir, 'bin');
  fs.mkdirSync(target, { recursive: true });
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.(exe|dll)$/i.test(e.name)) moveInto(p, path.join(target, e.name));
    }
  };
  walk(binDir);
}

function normalizePunct(dir) {
  const model = findFile(dir, 'model.onnx', 4);
  if (!model) throw new Error('压缩包中未找到 model.onnx');
  const srcDir = path.dirname(model);
  const target = dir;
  for (const f of fs.readdirSync(srcDir)) {
    if (/\.(onnx|txt)$/i.test(f)) moveInto(path.join(srcDir, f), path.join(target, f));
  }
}

/** 返回条目是否已就绪。 */
export function statusOf(id) {
  const e = CATALOG[id];
  if (!e) return { id, installed: false, label: id };
  let installed = false;
  if (e.kind === 'file') installed = fs.existsSync(e.dest) && fs.statSync(e.dest).size > (e.minSize ?? 1000);
  else if (e.kind === 'files') installed = e.files.every((f) => {
    const p = path.join(e.dest, f.name);
    try {
      return fs.statSync(p).size >= f.size * 0.9;
    } catch {
      return false;
    }
  });
  else if (e.kind === 'archive') installed = fs.existsSync(path.join(e.dest, '.installed'));
  let currentSize = 0;
  try {
    if (e.kind === 'archive') currentSize = dirSize(e.dest);
    else if (e.kind === 'files') currentSize = e.files.reduce((a, f) => a + sizeOf(path.join(e.dest, f.name)), 0);
    else currentSize = sizeOf(e.dest);
  } catch {}
  return { id, label: e.label, note: e.note, installed, size: e.size, currentSize };
}

function sizeOf(p) {
  try {
    return fs.statSync(p).size;
  } catch {
    return 0;
  }
}
function dirSize(p) {
  let total = 0;
  const walk = (d) => {
    let es;
    try {
      es = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of es) {
      const q = path.join(d, e.name);
      if (e.isDirectory()) walk(q);
      else total += sizeOf(q);
    }
  };
  walk(p);
  return total;
}

export function catalogStatus() {
  return Object.keys(CATALOG).map(statusOf);
}

// ---------------------------------------------------------------- 下载

const active = new Map();

export function cancelDownload(id) {
  const c = active.get(id);
  if (c) {
    c.abort();
    active.delete(id);
    return true;
  }
  return false;
}

export function cancelAll() {
  for (const id of [...active.keys()]) cancelDownload(id);
}

async function fetchToFile(url, dest, { onProgress, signal, expected } = {}) {
  let start = 0;
  try {
    start = fs.statSync(dest).size;
  } catch {}
  if (expected && start >= expected * 0.995) return; // 已完整
  const headers = { 'User-Agent': 'Mozilla/5.0 CourseNoteStudio' };
  if (start > 0) headers.Range = `bytes=${start}-`;
  let res;
  let lastErr;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      res = await fetch(url, { headers, signal, redirect: 'follow' });
      if (res.status === 416) return; // 已完成
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      break;
    } catch (e) {
      lastErr = e;
      if (signal?.aborted) throw new Error('已取消');
      await new Promise((r) => setTimeout(r, 1200 * (attempt + 1)));
    }
  }
  if (!res) throw lastErr ?? new Error('下载失败');
  // 服务器可能忽略 Range 直接返回 200（整份文件），此时必须从头写，否则会写坏文件
  const resumed = res.status === 206;
  const total = Number(res.headers.get('content-length') || 0) + (resumed ? start : 0);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const fh = await fsp.open(dest, resumed ? 'r+' : 'w');
  const stream = res.body;
  let written = resumed ? start : 0;
  let lastTick = 0;
  try {
    for await (const chunk of stream) {
      if (signal?.aborted) throw new Error('已取消');
      await fh.write(chunk, 0, chunk.length, written);
      written += chunk.length;
      const now = Date.now();
      if (onProgress && now - lastTick > 400) {
        lastTick = now;
        onProgress({ received: written, total: total || expected || 0 });
      }
    }
  } finally {
    await fh.close();
  }
  if (onProgress) onProgress({ received: written, total: total || expected || written });
}

function run(cmd, args, { cwd } = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { cwd, windowsHide: true });
    let err = '';
    p.stderr.on('data', (d) => (err += d.toString()));
    p.on('error', reject);
    p.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`${cmd} 退出码 ${code}: ${err.slice(0, 400)}`))));
  });
}

async function extract(archive, dest) {
  await fsp.mkdir(dest, { recursive: true });
  await run('tar', ['-xf', archive, '-C', dest]);
}

/** 下载并安装一个条目。 */
export async function install(id, { onProgress, log = () => {}, signal } = {}) {
  const e = CATALOG[id];
  if (!e) throw new Error(`未知资源：${id}`);
  const controller = new AbortController();
  const sig = controller.signal;
  if (signal) signal.addEventListener('abort', () => controller.abort(), { once: true });
  active.set(id, controller);
  try {
    if (e.kind === 'file' || e.kind === 'files') {
      const list = e.kind === 'file' ? [{ url: e.urls[0], name: path.basename(e.dest), size: e.size }] : e.files;
      for (const f of list) {
        const dest = e.kind === 'file' ? e.dest : path.join(e.dest, f.name);
        log(`下载 ${f.name} …`);
        await fetchToFile(f.url, dest, {
          signal: sig,
          expected: f.size,
          onProgress: (p) => onProgress?.({ id, file: f.name, ...p }),
        });
      }
    } else {
      const archivePath = path.join(TOOLS_DIR, '.cache', `${id}${guessExt(e.urls[0])}`);
      await fsp.mkdir(path.dirname(archivePath), { recursive: true });
      log(`下载 ${path.basename(archivePath)} …`);
      await fetchToFile(e.urls[0], archivePath, {
        signal: sig,
        expected: e.size,
        onProgress: (p) => onProgress?.({ id, file: path.basename(archivePath), ...p }),
      });
      log('解压中 …');
      await fsp.rm(e.dest, { recursive: true, force: true });
      await extract(archivePath, e.dest);
      if (e.normalize) {
        log('整理文件 …');
        e.normalize(e.dest);
      }
      fs.writeFileSync(path.join(e.dest, '.installed'), new Date().toISOString());
      await fsp.rm(archivePath, { force: true });
    }
    log(`${e.label} 安装完成`);
    return true;
  } finally {
    active.delete(id);
  }
}

function guessExt(url) {
  const m = url.match(/\.(zip|tar\.bz2|tar\.gz|7z)(\?|$)/i);
  return m ? '.' + m[1] : '.bin';
}

/** 串行安装多个条目（避免带宽争抢）。 */
export async function installMany(ids, { onProgress, log, signal } = {}) {
  const results = [];
  for (const id of ids) {
    const st = statusOf(id);
    if (st.installed) {
      log?.(`${st.label} 已就绪，跳过`);
      results.push({ id, ok: true, skipped: true });
      continue;
    }
    try {
      await install(id, { onProgress, log, signal });
      results.push({ id, ok: true });
    } catch (err) {
      log?.(`${CATALOG[id].label} 失败：${err.message}`);
      results.push({ id, ok: false, error: err.message });
      if (signal?.aborted) break;
    }
  }
  return results;
}

export { humanSize };
