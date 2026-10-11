// 统一路径定义：所有模块都从这里取路径，避免各处硬编码。
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

export const APP_DIR = path.dirname(path.dirname(fileURLToPath(import.meta.url))); // .../app
export const ROOT = path.dirname(APP_DIR); // .../CourseNoteStudio
export const TOOLS_DIR = path.join(ROOT, 'tools');
export const MODELS_DIR = path.join(ROOT, 'models');
export const DATA_DIR = path.join(ROOT, 'data');
export const PROJECTS_DIR = path.join(DATA_DIR, 'projects');
export const LOGS_DIR = path.join(ROOT, 'logs');
export const CACHE_DIR = path.join(DATA_DIR, 'cache');
export const PUBLIC_DIR = path.join(APP_DIR, 'public');
export const CONFIG_FILE = path.join(DATA_DIR, 'config.json');

for (const d of [TOOLS_DIR, MODELS_DIR, DATA_DIR, PROJECTS_DIR, LOGS_DIR, CACHE_DIR]) {
  fs.mkdirSync(d, { recursive: true });
}

/** 找可执行文件：先看 tools/ 下的相对路径，再退回 PATH。 */
export function toolPath(...rel) {
  return path.join(TOOLS_DIR, ...rel);
}

export function exists(p) {
  try {
    fs.accessSync(p);
    return true;
  } catch {
    return false;
  }
}

export function fileSize(p) {
  try {
    return fs.statSync(p).size;
  } catch {
    return 0;
  }
}

export function humanSize(bytes) {
  if (!bytes) return '0 B';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  let n = bytes;
  while (n >= 1024 && i < u.length - 1) {
    n /= 1024;
    i++;
  }
  return `${n.toFixed(n >= 100 || i === 0 ? 0 : 1)} ${u[i]}`;
}

/** DSH 的凭据文件（本机已有 DeepSeek key），用于「思考」环节。 */
export function dshCredentialFile() {
  return path.join(os.homedir(), '.dsh', '.credentials.yaml');
}

/** 在各处寻找 ffmpeg.exe / ffprobe.exe。 */
export function findFfmpeg() {
  const candidates = [
    toolPath('ffmpeg', 'bin', 'ffmpeg.exe'),
    toolPath('ffmpeg', 'ffmpeg.exe'),
    'ffmpeg.exe',
  ];
  for (const c of candidates) if (c.includes(path.sep) ? exists(c) : false) return c;
  return 'ffmpeg.exe';
}

export function findFfprobe() {
  const candidates = [toolPath('ffmpeg', 'bin', 'ffprobe.exe'), toolPath('ffmpeg', 'ffprobe.exe')];
  for (const c of candidates) if (exists(c)) return c;
  return 'ffprobe.exe';
}

export function findYtDlp() {
  const c = toolPath('yt-dlp.exe');
  return exists(c) ? c : 'yt-dlp.exe';
}

export function findLlamaServer(prefer = 'vulkan') {
  const order = prefer === 'cpu' ? ['cpu', 'vulkan'] : ['vulkan', 'cpu'];
  for (const k of order) {
    for (const rel of [['llamacpp-' + k, 'llama-server.exe'], ['llama-' + k, 'llama-server.exe']]) {
      const p = toolPath(...rel);
      if (exists(p)) return p;
    }
  }
  return null;
}

export function findSherpaCli() {
  const candidates = [
    toolPath('sherpa', 'bin', 'sherpa-onnx-offline.exe'),
    toolPath('sherpa', 'sherpa-onnx-offline.exe'),
    toolPath('sherpa', 'bin', 'sherpa-onnx-v1.13.8-win-x64-shared-MT-Release', 'bin', 'sherpa-onnx-offline.exe'),
  ];
  for (const c of candidates) if (exists(c)) return c;
  return null;
}

export function findEdge() {
  const candidates = [
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    path.join(os.homedir(), 'AppData', 'Local', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
  ];
  for (const c of candidates) if (exists(c)) return c;
  return null;
}
