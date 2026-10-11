// 语音识别：sherpa-onnx + SenseVoice，输出带时间戳的讲稿。
import fs from 'node:fs';
import path from 'node:path';
import { run, findSherpaCli, findFfmpeg } from './proc.mjs';
import { MODELS_DIR, fileSize } from './paths.mjs';

export function asrAssets() {
  const cli = findSherpaCli();
  const binDir = cli ? path.dirname(cli) : null;
  const modelDir = path.join(MODELS_DIR, 'asr', 'sensevoice');
  const punctDir = path.join(MODELS_DIR, 'asr', 'punct');
  const model = path.join(modelDir, 'model.int8.onnx');
  const tokens = path.join(modelDir, 'tokens.txt');
  const punctModel = path.join(punctDir, 'model.onnx');
  const vadModel = path.join(MODELS_DIR, 'asr', 'vad', 'silero_vad.onnx');
  // 有 VAD 时用带 VAD 的版本，句子切分与时间戳更准
  const vadCli = binDir
    ? ['sherpa-onnx-vad-with-offline-asr.exe', 'sherpa-onnx-vad-with-offline-asr'].map((f) => path.join(binDir, f)).find((f) => fs.existsSync(f))
    : null;
  return {
    cli,
    binDir,
    model: fs.existsSync(model) ? model : null,
    tokens: fs.existsSync(tokens) ? tokens : null,
    punctModel: fs.existsSync(punctModel) ? punctModel : null,
    vadModel: fs.existsSync(vadModel) ? vadModel : null,
    vadCli: vadCli || null,
    ready: !!(cli && fs.existsSync(model) && fs.existsSync(tokens)),
  };
}

function fmtTime(t) {
  const m = Math.floor(t / 60);
  const s = Math.floor(t % 60);
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

export { fmtTime };

/** 把长音频切成若干块，便于显示进度、降低内存占用。 */
async function splitAudio({ wav, outDir, chunkMinutes = 8, duration, onEvent, signal }) {
  const chunks = [];
  const chunkSec = chunkMinutes * 60;
  const n = Math.max(1, Math.ceil((duration || 0) / chunkSec));
  for (let i = 0; i < n; i++) {
    const start = i * chunkSec;
    const out = path.join(outDir, `chunk_${String(i).padStart(3, '0')}.wav`);
    if (!fs.existsSync(out) || fileSize(out) < 1000) {
      const r = await run(
        findFfmpeg(),
        ['-hide_banner', '-loglevel', 'error', '-nostdin', '-ss', String(start), '-t', String(chunkSec), '-i', wav, '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', '-y', out],
        { timeoutMs: 600000, signal },
      );
      if (r.code !== 0) throw new Error(`音频分块失败：${r.stderr.slice(0, 200)}`);
    }
    chunks.push({ file: out, offset: start });
  }
  return chunks;
}

/** 解析 sherpa-onnx-offline 的输出（兼容多种格式）。 */
function parseSherpaOutput(stdout) {
  const segs = [];
  for (const raw of stdout.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    // JSON 形式：{"text": "...", "timestamps": [...], ...}
    if (line.startsWith('{') && line.includes('"text"')) {
      try {
        const j = JSON.parse(line);
        const ts = j.timestamps || [];
        const start = ts.length ? ts[0] : 0;
        const end = ts.length ? ts[ts.length - 1] : start;
        if (j.text && j.text.trim()) segs.push({ start, end, text: j.text.trim() });
        continue;
      } catch {}
    }
    // 文本形式：0.000 -- 3.500 : 内容
    const m = line.match(/^([\d.]+)\s*--\s*([\d.]+)\s*:\s*(.+)$/);
    if (m) {
      segs.push({ start: Number(m[1]), end: Number(m[2]), text: m[3].trim() });
      continue;
    }
    const m2 = line.match(/^([\d.]+)\s*[-–]\s*([\d.]+)\s*:\s*(.+)$/);
    if (m2) segs.push({ start: Number(m2[1]), end: Number(m2[2]), text: m2[3].trim() });
  }
  return segs;
}

/** 主入口：音频 → 讲稿段落。 */
export async function transcribe({ wav, workDir, duration, options = {}, onEvent = () => {}, signal }) {
  const a = asrAssets();
  if (!a.ready) throw new Error('语音识别组件未安装（请先在「环境与模型」里一键安装）');
  const chunkDir = path.join(workDir, 'asr-chunks');
  fs.mkdirSync(chunkDir, { recursive: true });

  const outJson = path.join(workDir, 'transcript.json');
  const engineTag = a.vadCli && a.vadModel ? 'sense-voice+vad' : 'sense-voice';
  if (fs.existsSync(outJson)) {
    const cached = JSON.parse(fs.readFileSync(outJson, 'utf8'));
    // 引擎方式变了（例如新装了 VAD）就重跑，保证时间戳质量
    if (cached.segments?.length && (!cached.engine || cached.engine.endsWith(engineTag))) {
      onEvent({ type: 'log', message: `复用已有讲稿（${cached.segments.length} 段）` });
      return cached;
    }
  }

  const chunks = await splitAudio({
    wav,
    outDir: chunkDir,
    chunkMinutes: options.chunkMinutes ?? 8,
    duration,
    onEvent,
    signal,
  });

  const all = [];
  const useVad = !!(a.vadCli && a.vadModel);
  if (useVad) onEvent({ type: 'log', message: '使用语音活动检测切分句子（时间戳更准）' });
  for (let i = 0; i < chunks.length; i++) {
    const c = chunks[i];
    onEvent({ type: 'asr-progress', percent: Math.round((i / chunks.length) * 100), chunk: i + 1, total: chunks.length });
    const args = [];
    if (useVad) args.push(`--silero-vad-model=${a.vadModel}`);
    args.push(
      `--tokens=${a.tokens}`,
      `--sense-voice-model=${a.model}`,
      '--sense-voice-use-itn=true',
      `--num-threads=${options.threads ?? 8}`,
      '--print-args=false',
    );
    if (options.language && options.language !== 'auto') args.push(`--sense-voice-language=${options.language}`);
    args.push(c.file);
    const r = await run(useVad ? a.vadCli : a.cli, args, {
      cwd: path.dirname(a.cli),
      timeoutMs: 1000 * 60 * 60,
      signal,
      onLine: () => {},
    });
    const segs = parseSherpaOutput(r.stdout + '\n' + r.stderr);
    if (!segs.length && r.code !== 0) {
      onEvent({ type: 'log', level: 'error', message: `第 ${i + 1} 块识别失败：${r.stderr.slice(0, 200)}` });
    }
    for (const s of segs) all.push({ start: s.start + c.offset, end: s.end + c.offset, text: s.text });
  }

  // 合并同一块内被切碎的短句
  const merged = mergeSegments(all);
  const result = {
    language: options.language || 'auto',
    engine: `sherpa-onnx/${engineTag}`,
    segments: merged,
    text: merged.map((s) => `[${fmtTime(s.start)}] ${s.text}`).join('\n'),
    createdAt: new Date().toISOString(),
  };
  fs.writeFileSync(outJson, JSON.stringify(result, null, 2), 'utf8');
  onEvent({ type: 'asr-progress', percent: 100, chunk: chunks.length, total: chunks.length });
  onEvent({ type: 'log', message: `语音识别完成，共 ${merged.length} 段` });
  return result;
}

function mergeSegments(segs) {
  const out = [];
  const MAX_SEG = 40; // 单段最长 40 秒，保证与板书时间轴对齐的精度
  for (const s of segs) {
    if (!s.text) continue;
    const prev = out[out.length - 1];
    if (prev && s.start - prev.end < 1.0 && s.end - prev.start < MAX_SEG) {
      prev.text = joinText(prev.text, s.text);
      prev.end = s.end;
    } else {
      out.push({ ...s });
    }
  }
  return out;
}

function joinText(a, b) {
  if (!a) return b;
  if (!b) return a;
  const needSpace = /[A-Za-z0-9]$/.test(a) && /^[A-Za-z0-9]/.test(b);
  return a + (needSpace ? ' ' : '') + b;
}

/** 用标点模型给讲稿补标点（可选）。 */
export async function punctuate({ transcript, workDir, onEvent = () => {}, signal }) {
  const a = asrAssets();
  if (!a.punctModel) return transcript;
  const binDir = path.dirname(a.cli);
  const cli = ['sherpa-onnx-offline-punctuation.exe', 'sherpa-onnx-offline-punctuation'].map((f) => path.join(binDir, f)).find((f) => fs.existsSync(f));
  if (!cli) return transcript;
  const tokens = path.join(path.dirname(a.punctModel), 'tokens.txt');
  if (!fs.existsSync(tokens)) return transcript;

  const inFile = path.join(workDir, 'asr-plain.txt');
  const outFile = path.join(workDir, 'asr-punct.txt');
  fs.writeFileSync(inFile, transcript.segments.map((s) => s.text).join('\n'), 'utf8');
  const r = await run(
    cli,
    [`--ct-transformer=${a.punctModel}`, `--tokens=${tokens}`, '--print-args=false', inFile],
    { cwd: binDir, timeoutMs: 1800000, signal },
  );
  const lines = (r.stdout || '')
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean)
    .filter((s) => !/^--|^Started|^Done|^num_threads|^Elapsed/i.test(s));
  const texts = lines.filter((l) => !l.startsWith('{') || !l.includes('"'));
  if (texts.length === transcript.segments.length) {
    transcript.segments = transcript.segments.map((s, i) => ({ ...s, text: texts[i] }));
    fs.writeFileSync(outFile, texts.join('\n'), 'utf8');
    onEvent({ type: 'log', message: '已用标点模型补全标点' });
  }
  return transcript;
}
