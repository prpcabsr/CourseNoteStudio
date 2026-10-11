// 「看」：用本地视觉大模型（llama.cpp）或任意 OpenAI 兼容多模态接口读板书。
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { MODELS_DIR, findLlamaServer, fileSize } from './paths.mjs';
import { repairJsonEscapes } from './json.mjs';
import { repairLatex } from './latex.mjs';

const VLM_PRESETS = {
  'vlm-qwen3vl-4b': {
    label: 'Qwen3-VL-4B',
    dir: path.join(MODELS_DIR, 'vlm', 'qwen3-vl-4b'),
    model: 'Qwen3VL-4B-Instruct-Q4_K_M.gguf',
    mmproj: 'mmproj-Qwen3VL-4B-Instruct-Q8_0.gguf',
  },
  'vlm-qwen25vl-3b': {
    label: 'Qwen2.5-VL-3B',
    dir: path.join(MODELS_DIR, 'vlm', 'qwen25-vl-3b'),
    model: 'Qwen2.5-VL-3B-Instruct-Q4_K_M.gguf',
    mmproj: 'mmproj-Qwen2.5-VL-3B-Instruct-Q8_0.gguf',
  },
};

export function vlmAssets(modelId) {
  const p = VLM_PRESETS[modelId] || VLM_PRESETS['vlm-qwen3vl-4b'];
  const model = path.join(p.dir, p.model);
  const mmproj = path.join(p.dir, p.mmproj);
  return { ...p, id: modelId, model, mmproj, ready: fileSize(model) > 1e8 && fileSize(mmproj) > 1e6 };
}

export function vlmStatus() {
  return Object.keys(VLM_PRESETS).map((id) => ({ id, ...vlmAssets(id) }));
}

function freePort() {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const p = srv.address().port;
      srv.close(() => resolve(p));
    });
  });
}

let serverHandle = null;
let deviceCache = null;

/**
 * 列出可用计算设备并挑一块最合适的显卡。
 * 多显卡机器上 llama.cpp 默认会用 0 号设备（常常是核显），必须显式指定独显。
 */
export async function pickDevice(bin, onEvent = () => {}, force = '') {
  if (force) return force;
  if (deviceCache !== null) return deviceCache;
  const list = await new Promise((resolve) => {
    const p = spawn(bin, ['--list-devices'], { cwd: path.dirname(bin), windowsHide: true });
    let out = '';
    p.stdout.on('data', (d) => (out += d.toString()));
    p.stderr.on('data', (d) => (out += d.toString()));
    p.on('close', () => resolve(out));
    p.on('error', () => resolve(''));
    setTimeout(() => {
      try {
        p.kill();
      } catch {}
      resolve(out);
    }, 20000);
  });
  const devices = [];
  for (const line of String(list).split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z]+\d+):\s*(.+?)\s*\((\d+)\s*MiB,\s*(\d+)\s*MiB free\)/);
    if (m) devices.push({ name: m[1], desc: m[2], total: Number(m[3]), free: Number(m[4]) });
  }
  if (!devices.length) {
    deviceCache = '';
    return deviceCache;
  }
  const score = (d) => {
    let s = d.free / 1024;
    if (/nvidia|geforce|rtx|quadro|tesla|radeon|rx\s?\d|arc\s?a/i.test(d.desc)) s += 1000;
    if (/intel|uhd graphics|iris|hd graphics|microsoft basic/i.test(d.desc)) s -= 1000;
    return s;
  };
  devices.sort((a, b) => score(b) - score(a));
  const best = devices[0];
  onEvent({ type: 'log', message: `推理设备：${best.desc}（可用 ${(best.free / 1024).toFixed(1)} GB）` });
  deviceCache = best.name;
  return deviceCache;
}

async function waitHealth(port, timeoutMs = 180000, onEvent = () => {}) {
  const t0 = Date.now();
  let lastLog = 0;
  while (Date.now() - t0 < timeoutMs) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(3000) });
      if (r.ok) {
        const j = await r.json().catch(() => ({}));
        if (j.status === 'ok' || r.status === 200) return true;
      }
    } catch {}
    if (Date.now() - lastLog > 8000) {
      lastLog = Date.now();
      onEvent({ type: 'log', message: `正在加载视觉模型…（${Math.round((Date.now() - t0) / 1000)}s）` });
    }
    await new Promise((r) => setTimeout(r, 700));
  }
  return false;
}

/** 启动本地推理服务（同一进程内复用）。 */
export async function ensureLocalServer({ modelId = 'vlm-qwen3vl-4b', gpuLayers = 99, ctxSize = 8192, threads = 8, prefer = 'vulkan', device = '', onEvent = () => {} } = {}) {
  const a = vlmAssets(modelId);
  if (!a.ready) throw new Error(`视觉模型未安装：${a.label}`);
  if (serverHandle && serverHandle.modelId === modelId && serverHandle.proc.exitCode === null) {
    return serverHandle;
  }
  if (serverHandle) {
    try {
      serverHandle.proc.kill();
    } catch {}
    serverHandle = null;
  }
  let bin = findLlamaServer(prefer);
  if (!bin) {
    // 退回到实际存在的那个
    bin = findLlamaServer(prefer === 'cpu' ? 'vulkan' : 'cpu');
  }
  if (!bin) throw new Error('未找到 llama-server（请先安装推理引擎）');
  const port = await freePort();
  const dev = gpuLayers > 0 ? await pickDevice(bin, onEvent, device) : '';
  const args = [
    '-m', a.model,
    '--mmproj', a.mmproj,
    '-ngl', String(gpuLayers),
    '-c', String(ctxSize),
    '-t', String(threads),
    '--host', '127.0.0.1',
    '--port', String(port),
    '-np', '1',
    '--jinja',
    '--no-warmup',
    '-fa', 'auto',
  ];
  if (dev) args.push('--device', dev);
  onEvent({ type: 'log', message: `启动视觉引擎：${path.basename(bin)}（${a.label}）` });
  const proc = spawn(bin, args, { cwd: path.dirname(bin), windowsHide: true });
  let stderrTail = '';
  proc.stderr.on('data', (d) => {
    stderrTail = (stderrTail + d.toString()).slice(-4000);
  });
  proc.stdout.on('data', () => {});
  proc.on('exit', (code) => {
    if (serverHandle?.proc === proc) {
      onEvent({ type: 'log', level: 'error', message: `视觉引擎退出（code ${code}）` });
      serverHandle = null;
    }
  });
  serverHandle = { modelId, port, proc, bin, get stderr() { return stderrTail; } };
  const ok = await waitHealth(port, 240000, onEvent);
  if (!ok) {
    const tail = stderrTail.split('\n').slice(-8).join(' ').slice(0, 400);
    try {
      proc.kill();
    } catch {}
    serverHandle = null;
    throw new Error(`视觉引擎启动超时：${tail}`);
  }
  onEvent({ type: 'log', message: `视觉引擎就绪（端口 ${port}）` });
  return serverHandle;
}

export function stopLocalServer() {
  if (serverHandle) {
    try {
      serverHandle.proc.kill();
    } catch {}
    serverHandle = null;
  }
}

export function localServerInfo() {
  return serverHandle ? { port: serverHandle.port, pid: serverHandle.proc.pid, modelId: serverHandle.modelId } : null;
}

// ------------------------------------------------------------------ 识别提示词

const BOARD_PROMPT = `你是课堂板书识别助手。请仔细观察这张课堂截图（可能是黑板、白板、投影PPT或讲义），把你**看到的内容原样转录**出来。

要求：
1. 只转录画面中真实存在的文字、公式、符号、图表标注；不要总结、不要翻译、不要补充画面没有的内容。
2. 数学公式用 LaTeX 表示，行内写成 $...$，独立成行写成 $$...$$；不要使用 \\( \\) 或 \\[ \\]。公式必须原样保留，不要改写。
   上下标**一定要用花括号包起来**，尤其是积分号和求和号，否则排版会错位。正确写法示例：
   $\oint_{L} f(z)\,dz = 2\pi i \sum_{k=1}^{n} \operatorname{Res}_{z=b_k} f(z)$、$\lim_{x \to x_0} f(x)$、$\int_{0}^{1} x^2\,dx$。
   错误写法（不要这样写）：\oint L f(z)dz = 2\pi i k=1∑n Res z=bk f(z)、\sum k=1 n、\lim x→x0。
3. 一张画面里同时有手写黑板和投影幕布时，**以手写板书为主**；幕布上重复的内容不要写两遍。
4. 忽略与课程无关的内容：视频水印、UP 主昵称、台标、弹幕、时间码、机位标注。
5. 按阅读顺序（从上到下、从左到右、分栏先左后右）输出。
6. 看不清的字用 ▢ 占位；完全看不清的整块内容写「（此处模糊）」。
7. 每个公式只写一遍，**不要重复输出相同的内容**。
8. 若画面主体是讲课的老师/学生/实验设备而没有板书内容，text 填空字符串。

严格输出一个 JSON 对象，不要输出任何多余文字或代码块标记：
{"scene":"board|whiteboard|slide|document|person|other","title":"这一屏的主题（没有就填空字符串）","text":"完整转录内容（Markdown）","layout":"一句话描述版面布局","confidence":"high|medium|low"}`;

/** 读取一张板书图片。 */
export async function readBoardImage({ imagePath, cfg, onEvent = () => {}, signal, prompt }) {
  const b64 = fs.readFileSync(imagePath).toString('base64');
  const dataUrl = `data:image/jpeg;base64,${b64}`;
  const messages = [
    {
      role: 'user',
      content: [
        { type: 'image_url', image_url: { url: dataUrl } },
        { type: 'text', text: prompt || BOARD_PROMPT },
      ],
    },
  ];
  const useLocal = cfg.mode !== 'openai-compatible';
  let endpoint;
  let model;
  let apiKey = cfg.apiKey;
  if (useLocal) {
    const s = await ensureLocalServer({
      modelId: cfg.modelId,
      gpuLayers: cfg.gpuLayers,
      ctxSize: cfg.ctxSize,
      threads: cfg.threads,
      device: cfg.device || '',
      onEvent,
    });
    endpoint = `http://127.0.0.1:${s.port}/v1/chat/completions`;
    model = 'local';
  } else {
    if (!cfg.endpoint) throw new Error('未配置视觉模型接口地址');
    endpoint = cfg.endpoint.replace(/\/$/, '') + (cfg.endpoint.includes('/chat/completions') ? '' : '/v1/chat/completions');
    model = cfg.model || 'gpt-4o-mini';
  }
  const body = {
    model,
    messages,
    max_tokens: cfg.maxTokens ?? 1200,
    temperature: 0.2,
    top_p: 0.9,
    repeat_penalty: 1.08, // 防止小模型陷入重复输出
    stream: false,
  };
  // 本地 llama.cpp 支持用 JSON 语法约束输出，能极大减少解析失败
  if (useLocal) body.response_format = { type: 'json_object' };
  const t0 = Date.now();
  let res = await postChat(endpoint, body, apiKey, signal);
  if (!res.ok && useLocal && body.response_format) {
    // 个别版本不支持该字段，去掉重试一次
    delete body.response_format;
    res = await postChat(endpoint, body, apiKey, signal);
  }
  if (!res.ok) {
    const t = await res.text();
    throw new Error(`视觉识别请求失败（${res.status}）：${t.slice(0, 300)}`);
  }
  const j = await res.json();
  const content = j.choices?.[0]?.message?.content ?? '';
  const parsed = parseBoardJson(content);
  return { ...parsed, raw: typeof content === 'string' ? content : JSON.stringify(content), ms: Date.now() - t0 };
}

function postChat(endpoint, body, apiKey, signal) {
  return fetch(endpoint, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
    },
    body: JSON.stringify(body),
    signal,
  });
}

/**
 * 带图提问：把图片交给视觉模型，回答一个自由问题（不做 JSON 约束）。
 * 用于「AI 问答」面板里对板书图片提问。
 */
export async function askWithImages({ imagePaths, prompt, cfg, onEvent = () => {}, signal }) {
  const content = [];
  for (const p of imagePaths) {
    const b64 = fs.readFileSync(p).toString('base64');
    content.push({ type: 'image_url', image_url: { url: `data:image/jpeg;base64,${b64}` } });
  }
  content.push({ type: 'text', text: prompt });
  const useLocal = cfg.mode !== 'openai-compatible';
  let endpoint;
  let model;
  const apiKey = cfg.apiKey;
  if (useLocal) {
    const s = await ensureLocalServer({
      modelId: cfg.modelId,
      gpuLayers: cfg.gpuLayers,
      ctxSize: cfg.ctxSize,
      threads: cfg.threads,
      device: cfg.device || '',
      onEvent,
    });
    endpoint = `http://127.0.0.1:${s.port}/v1/chat/completions`;
    model = 'local';
  } else {
    if (!cfg.endpoint) throw new Error('未配置视觉模型接口地址');
    endpoint = cfg.endpoint.replace(/\/$/, '') + (cfg.endpoint.includes('/chat/completions') ? '' : '/v1/chat/completions');
    model = cfg.model || 'gpt-4o-mini';
  }
  const res = await postChat(
    endpoint,
    { model, messages: [{ role: 'user', content }], max_tokens: cfg.maxTokens ?? 1200, temperature: 0.3, top_p: 0.9, repeat_penalty: 1.08, stream: false },
    apiKey,
    signal,
  );
  if (!res.ok) {
    const t = await res.text();
    throw new Error(`视觉模型回答失败（${res.status}）：${t.slice(0, 200)}`);
  }
  const j = await res.json();
  const out = j.choices?.[0]?.message?.content ?? '';
  return typeof out === 'string' ? out : JSON.stringify(out);
}

/** 从可能不严格的 JSON 里取字段（本地小模型常输出带裸换行的 JSON）。 */
function fieldOf(raw, name) {
  const re = new RegExp(`"${name}"\\s*:\\s*"([\\s\\S]*?)"\\s*(?=,\\s*"[a-zA-Z_]+"\\s*:|}\\s*$)`, 'm');
  const m = raw.match(re);
  if (!m) return null;
  return unescapeLoose(m[1]);
}

/** JSON 被 max_tokens 截断时，从 "text": " 一路取到结尾。 */
function fieldOfTruncated(raw, name) {
  const re = new RegExp(`"${name}"\\s*:\\s*"([\\s\\S]+)$`);
  const m = raw.match(re);
  if (!m) return null;
  return unescapeLoose(m[1]);
}

function unescapeLoose(s) {
  return s
    .replace(/\\n/g, '\n')
    .replace(/\\t/g, '\t')
    .replace(/\\"/g, '"')
    .replace(/\\u([0-9a-fA-F]{4})/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/\\\\/g, '\\');
}

/** 清理识别文本：去掉连续重复行（模型偶尔会陷入重复输出）、补全公式上下标、限制长度。 */
export function cleanBoardText(text) {
  if (!text) return '';
  let lines = String(text).split('\n');
  const out = [];
  for (const line of lines) {
    const key = line.trim();
    if (key && out.length && out[out.length - 1].trim() === key) continue; // 连续重复的只保留一次
    out.push(line);
  }
  let s = repairLatex(out.join('\n')).replace(/\n{3,}/g, '\n\n').trim();
  if (s.length > 1500) s = s.slice(0, 1500) + '\n…（内容过长已截断）';
  return s;
}

export function parseBoardJson(content) {
  const text = typeof content === 'string' ? content : JSON.stringify(content);
  const cleaned = text.replace(/^```(?:json)?/m, '').replace(/```\s*$/m, '').trim();
  const tryParse = (s) => {
    // 板书里的 LaTeX（\frac、\oint…）在 JSON 里是非法转义，先补一下再解析
    try {
      return JSON.parse(repairJsonEscapes(s));
    } catch {
      return null;
    }
  };
  let obj = tryParse(cleaned);
  if (!obj) {
    const m = cleaned.match(/\{[\s\S]*\}/);
    if (m) obj = tryParse(m[0]);
  }
  if (!obj) {
    // 兜底一：逐字段抽取（模型把换行写成了裸换行时 JSON.parse 会失败）
    const t = fieldOf(cleaned, 'text') ?? fieldOfTruncated(cleaned, 'text');
    if (t !== null && t !== undefined) {
      return {
        scene: fieldOf(cleaned, 'scene') || 'board',
        title: fieldOf(cleaned, 'title') || '',
        text: cleanBoardText(t),
        layout: fieldOf(cleaned, 'layout') || '',
        confidence: fieldOf(cleaned, 'confidence') || 'medium',
        repaired: true,
      };
    }
    // 兜底二：确实不是 JSON（整段当正文）
    return { scene: 'board', title: '', text: cleanBoardText(cleaned), layout: '', confidence: 'low', degraded: !cleaned.startsWith('{') };
  }
  return {
    scene: String(obj.scene || 'board'),
    title: String(obj.title || ''),
    text: cleanBoardText(String(obj.text || '')),
    layout: String(obj.layout || ''),
    confidence: String(obj.confidence || 'medium'),
  };
}

export { VLM_PRESETS };
