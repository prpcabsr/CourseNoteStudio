// 配置：读写 data/config.json；DeepSeek key 优先复用本机 DSH 已保存的凭据。
import fs from 'node:fs';
import { CONFIG_FILE, dshCredentialFile } from './paths.mjs';

export const DEFAULTS = {
  llm: {
    // 「思考」环节使用的文本大模型
    baseUrl: 'https://api.deepseek.com',
    model: 'deepseek-chat',
    apiKey: '',
    useDshKey: true,
    temperature: 0.3,
    maxTokens: 4096,
    concurrency: 3,
  },
  vlm: {
    // 「看」环节使用的视觉模型
    mode: 'local', // local | openai-compatible
    modelId: 'vlm-qwen3vl-4b',
    endpoint: '',
    apiKey: '',
    model: '',
    gpuLayers: 99,
    ctxSize: 8192,
    maxTokens: 1200,
    threads: 8,
    parallel: 1,
  },
  asr: {
    enabled: true,
    threads: 8,
    chunkMinutes: 8,
  },
  capture: {
    probeFps: 1,
    density: 'balanced', // sparse | balanced | dense（抓拍间隔与阈值由档位决定）
    eraseRatio: 0.35,
    maxSnapshots: 300,
    autoCrop: true,
    imageWidth: 1600,
  },
  output: {
    courseName: '',
    // PDF 默认只保留核心内容；板书截图/板书时间线/讲稿都在网页「笔记章节」里看，
    // 想把它们也放进 PDF，就在设置里打开对应开关。
    includeBoardImages: false,
    includeBoardTimeline: false,
    includeTranscript: false,
    includeTimestamp: true,
    paper: 'A4',
    paperStyle: 'white', // white | cream | lined（米黄横线笔记本纸）
    font: 'wenkai', // system | wenkai | kaiti | songti
    theme: 'paper',
  },
  download: {
    cookiesFromBrowser: '',
    quality: '1080',
  },
};

function deepMerge(base, patch) {
  if (Array.isArray(base) || typeof base !== 'object' || base === null) return patch ?? base;
  const out = { ...base };
  for (const [k, v] of Object.entries(patch ?? {})) {
    out[k] = k in base && typeof base[k] === 'object' && base[k] && !Array.isArray(base[k]) ? deepMerge(base[k], v) : v;
  }
  return out;
}

export function loadConfig() {
  let saved = {};
  try {
    saved = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
  } catch {}
  return deepMerge(DEFAULTS, saved);
}

export function saveConfig(cfg) {
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2), 'utf8');
  return cfg;
}

export function updateConfig(patch) {
  const cfg = deepMerge(loadConfig(), patch);
  return saveConfig(cfg);
}

/** 从 DSH 的凭据文件里读取 DeepSeek key（不复制、不落盘到项目里）。 */
export function readDshDeepseekKey() {
  try {
    const text = fs.readFileSync(dshCredentialFile(), 'utf8');
    const m = text.match(/DEEPSEEK_API_KEY:\s*(\S+)/);
    return m ? m[1].trim() : '';
  } catch {
    return '';
  }
}

export function resolveLlmKey(cfg) {
  if (cfg.llm.apiKey) return { key: cfg.llm.apiKey, source: 'config' };
  if (cfg.llm.useDshKey) {
    const k = readDshDeepseekKey();
    if (k) return { key: k, source: 'dsh' };
  }
  if (process.env.DEEPSEEK_API_KEY) return { key: process.env.DEEPSEEK_API_KEY, source: 'env' };
  return { key: '', source: 'none' };
}

export function maskKey(k) {
  if (!k) return '';
  return k.slice(0, 6) + '…' + k.slice(-4);
}
