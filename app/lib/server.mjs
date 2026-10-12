// 本地 Web 服务：给界面提供 API + 进度推送（SSE）。
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { URL } from 'node:url';
import { PUBLIC_DIR, findEdge, findFfmpeg, findSherpaCli, findLlamaServer, MODELS_DIR, DATA_DIR, toolPath } from './paths.mjs';
import { catalogStatus, install, installMany, CORE_IDS, cancelDownload, CATALOG } from './download.mjs';
import { loadConfig, updateConfig, resolveLlmKey, maskKey } from './config.mjs';
import { createProject, listProjects, loadState, projectPaths, deleteProject, readJson, writeJson } from './project.mjs';
import { runPipeline, cancelProject, isRunning, renderProject, exportPdf, STAGES } from './pipeline.mjs';
import { vlmStatus, stopLocalServer, localServerInfo, askWithImages } from './vision.mjs';
import { callLlm } from './fusion.mjs';
import { searchExact, searchAi, invalidateSearchCache } from './search.mjs';
import { generateSupplements, loadSupplements } from './supplement.mjs';
import { auditNotes, loadAudit } from './audit.mjs';
import { generateSummary, listSummaries, loadSummary, listPickable } from './summary.mjs';
import { asrAssets } from './asr.mjs';
import { isUrl, normalizeVideoInput } from './ingest.mjs';
import { mdToHtml, lookCss, textToHtml, titleMath } from './render.mjs';
import { repairLatex } from './latex.mjs';
import fsx from 'node:fs';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.ttf': 'font/ttf',
  '.pdf': 'application/pdf',
  '.md': 'text/markdown; charset=utf-8',
};

// ------------------------------------------------------------------ 事件总线
const subscribers = new Set();
const clientInfo = new Map(); // res -> {at, ua, addr}，诊断用
const buffers = new Map(); // projectId -> ring buffer

function broadcast(event) {
  const pid = event.projectId || 'system';
  const buf = buffers.get(pid) || [];
  buf.push(event);
  if (buf.length > 800) buf.splice(0, buf.length - 800);
  buffers.set(pid, buf);
  const line = `data: ${JSON.stringify(event)}\n\n`;
  for (const res of subscribers) {
    try {
      res.write(line);
    } catch {}
  }
}

function send(res, code, body, headers = {}) {
  const data = typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body);
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers });
  res.end(data);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let b = '';
    req.on('data', (d) => {
      b += d;
      if (b.length > 5_000_000) req.destroy();
    });
    req.on('end', () => {
      try {
        resolve(b ? JSON.parse(b) : {});
      } catch {
        resolve({});
      }
    });
    req.on('error', reject);
  });
}

function safeJoin(root, rel) {
  const p = path.normalize(path.join(root, rel));
  if (!p.startsWith(path.normalize(root))) return null;
  return p;
}

/**
 * 任务队列。
 *
 * 为什么需要：一节课的流水线里，「识别板书」用的是**单实例视觉模型**（-np 1），
 * 「抽帧」吃 CPU，「下载」吃带宽。如果用户一次点开五六个视频一起跑，
 * 它们会互相抢这三样资源，结果是**每个都变得很慢**，而且看起来像卡住了。
 * 所以这里限制同时运行的任务数（默认 2：一个在识别、一个在下载/转写，互不打架），
 * 其余排队，并在界面上显示排队位置。
 */
const taskQueue = [];
let activeTasks = 0;
function queueState() {
  const cfg = loadConfig();
  const max = Math.max(1, Number(cfg.run?.maxConcurrentTasks) || 2);
  return {
    max,
    active: activeTasks,
    waiting: taskQueue.map((t) => t.projectId),
    positionOf: (pid) => {
      const i = taskQueue.findIndex((t) => t.projectId === pid);
      return i < 0 ? 0 : i + 1;
    },
  };
}

function pumpQueue() {
  const { max } = queueState();
  while (activeTasks < max && taskQueue.length) {
    const job = taskQueue.shift();
    activeTasks++;
    broadcast({ projectId: job.projectId, type: 'log', message: '▶ 开始处理' });
    runPipeline({ projectId: job.projectId, onEvent: broadcast, force: job.force || {} })
      .catch(() => {})
      .finally(() => {
        activeTasks--;
        const rest = queueState();
        // 通知还在排队的任务：往前挪了
        rest.waiting.forEach((pid, i) => {
          broadcast({ projectId: pid, type: 'queued', position: i + 1, active: rest.active, max: rest.max });
        });
        pumpQueue();
      });
  }
}

function startQueued(projectId, force = {}) {
  const st = queueState();
  if (st.active < st.max && !taskQueue.length) {
    activeTasks++;
    broadcast({ projectId, type: 'log', message: '▶ 开始处理' });
    runPipeline({ projectId, onEvent: broadcast, force })
      .catch(() => {})
      .finally(() => {
        activeTasks--;
        const rest = queueState();
        rest.waiting.forEach((pid, i) => {
          broadcast({ projectId: pid, type: 'queued', position: i + 1, active: rest.active, max: rest.max });
        });
        pumpQueue();
      });
    return;
  }
  taskQueue.push({ projectId, force });
  const pos = queueState().positionOf(projectId);
  broadcast({
    projectId,
    type: 'queued',
    position: pos,
    active: st.active,
    max: st.max,
    message: `前面还有 ${pos - 1} 个任务在跑，已排队（同时最多 ${st.max} 个）。这样每个任务反而更快跑完。`,
  });
}

function serveStatic(res, abs) {
  if (!fs.existsSync(abs) || fs.statSync(abs).isDirectory()) return send(res, 404, { error: 'not found' });
  const ext = path.extname(abs).toLowerCase();
  const st = fs.statSync(abs);
  // 必须 no-store：本地程序改了代码之后，浏览器若拿缓存，用户按 F5 看到的还是旧界面
  // （之前踩过好几次）。只写 no-cache 而没有 ETag/Last-Modified 时，浏览器没法重新校验，
  // 照样会用缓存。
  res.writeHead(200, {
    'content-type': MIME[ext] || 'application/octet-stream',
    'cache-control': 'no-store, must-revalidate',
    pragma: 'no-cache',
    etag: `W/"${st.size}-${Math.round(st.mtimeMs).toString(36)}"`,
  });
  fs.createReadStream(abs).pipe(res);
}

// ------------------------------------------------------------------ 环境状态
/**
 * 回答笔记里的提问。
 * 有图片 → 走视觉模型（本地 Qwen3-VL 或外部接口）；
 * 纯文字 → 走文本模型（默认 DeepSeek），并把选中的片段与该节笔记作为背景一起给它。
 */
async function answerQuestion({ question, selection, section, imgPaths, cfg, state, projectId }) {
  const course = state.options?.courseName || cfg.output.courseName || '';
  const title = state.title || state.output?.docTitle || '';
  const head = [
    '你是这门课的助教，正在帮学生复习他自己的课程笔记。',
    '只依据下面提供的材料回答；材料里没有的不要编。如果材料不足以回答，就直说「笔记里没有写到这一点」。',
    '回答用简体中文，简洁清楚；涉及公式用 LaTeX（行内 $...$，独立成行 $$...$$）。',
    '不要重复复述整段材料，直接回答问题本身。',
    '',
    `【课程】${title}${course ? '（' + course + '）' : ''}`,
  ];
  if (section?.title) head.push(`【当前章节】${section.title}${section.time ? '（' + section.time + '）' : ''}`);
  if (section?.text) head.push(`【这一节的笔记】\n${String(section.text).slice(0, 4000)}`);
  if (selection) head.push(`【学生选中的内容】\n${selection.slice(0, 2000)}`);
  if (question) head.push(`【学生的问题】${question}`);

  if (imgPaths.length) {
    const prompt = [...head, '', '（下面还附了板书/笔记的截图，请结合图片内容回答；看不清的地方直接说明。）'].join('\n');
    const answer = await askWithImages({
      imagePaths: imgPaths,
      prompt,
      cfg: cfg.vlm,
      onEvent: () => {},
    });
    return { answer: answer.trim(), engine: cfg.vlm.mode === 'openai-compatible' ? `视觉模型 ${cfg.vlm.model || '外部接口'}` : `本地视觉模型` };
  }

  const { key, source } = resolveLlmKey(cfg);
  if (!key) throw new Error('还没有配置文本模型 Key，请在「环境与模型 → 文本模型」里填写');
  const { content } = await callLlm({ cfg, messages: [{ role: 'user', content: head.join('\n') }] });
  return { answer: content.trim(), engine: `${cfg.llm.model}（${source === 'dsh' ? '本机 DSH Key' : source}）` };
}

export function environmentStatus() {
  const cfg = loadConfig();
  const { key, source } = resolveLlmKey(cfg);
  const asr = asrAssets();
  const vlm = vlmStatus();
  const resources = catalogStatus();
  return {
    node: process.version,
    platform: process.platform,
    ffmpeg: fs.existsSync(toolPath('ffmpeg', 'bin', 'ffmpeg.exe')),
    ytdlp: fs.existsSync(toolPath('yt-dlp.exe')),
    llamaServer: !!findLlamaServer('vulkan'),
    edge: !!findEdge(),
    asr: { ready: asr.ready, cli: !!asr.cli, model: !!asr.model, punct: !!asr.punctModel },
    vlm: vlm.map((v) => ({ id: v.id, label: v.label, ready: v.ready })),
    llm: { ready: !!key, source, keyMasked: maskKey(key), model: cfg.llm.model, baseUrl: cfg.llm.baseUrl },
    resources,
    coreInstalled: CORE_IDS.every((id) => resources.find((r) => r.id === id)?.installed),
    vlmServer: localServerInfo(),
    stages: STAGES,
  };
}

// ------------------------------------------------------------------ 服务
export function startServer({ port = 7788, host = '127.0.0.1', open = true, autoClose = true, onShutdown = null } = {}) {
  const life = { lastClientAt: 0, startedAt: Date.now(), closing: false, timer: null, autoClose: !!autoClose };

  const shutdown = (reason) => {
    if (life.closing) return;
    life.closing = true;
    if (life.timer) clearInterval(life.timer);
    try {
      broadcast({ type: 'server-exit', message: reason });
      for (const res of subscribers) {
        try {
          res.end();
        } catch {}
      }
    } catch {}
    try {
      onShutdown && onShutdown();
    } catch {}
    console.log('');
    console.log(`  ${reason}，课程笔记工坊已自动退出。`);
    console.log('  需要时再双击「启动.bat」即可。');
    console.log('');
    try {
      server.closeAllConnections?.();
    } catch {}
    server.close(() => process.exit(0));
    // 兜底：2 秒内没退干净就强制退出
    setTimeout(() => process.exit(0), 2000).unref?.();
  };

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const p = url.pathname;
    try {
      // ---- SSE
      if (p === '/api/events') {
        res.writeHead(200, {
          'content-type': 'text/event-stream; charset=utf-8',
          'cache-control': 'no-cache, no-transform',
          connection: 'keep-alive',
          'x-accel-buffering': 'no',
        });
        res.write(': connected\n\n');
        subscribers.add(res);
        life.lastClientAt = Date.now();
        clientInfo.set(res, { at: Date.now(), ua: String(req.headers['user-agent'] || '').slice(0, 60), addr: req.socket?.remoteAddress || '' });
        const drop = () => {
          clearInterval(keep);
          subscribers.delete(res);
          clientInfo.delete(res);
        };
        const keep = setInterval(() => {
          // 连接真的断了（用户关了页面）时，这里能第一时间发现
          if (res.destroyed || res.writableEnded) return drop();
          try {
            res.write(': ping\n\n');
          } catch {
            drop();
          }
        }, 10000);
        res.on('error', drop);
        res.on('close', drop);
        req.on('close', drop);
        req.on('aborted', drop);
        return;
      }

      if (p === '/api/search') {
        const q = url.searchParams.get('q') || '';
        const mode = url.searchParams.get('mode') || 'exact';
        if (!q.trim()) return send(res, 200, { hits: [], total: 0, mode });
        if (mode === 'ai') {
          const cfg = loadConfig();
          const { key } = resolveLlmKey(cfg);
          if (!key) {
            return send(res, 400, { error: 'AI 模糊搜索需要文本模型 Key，请在「环境与模型 → 文本模型」里配置；也可以先用「原话」精确搜索。' });
          }
          try {
            const r = await searchAi({ query: q, cfg });
            return send(res, 200, { ...r, total: r.hits.length, mode });
          } catch (e) {
            return send(res, 500, { error: 'AI 搜索失败：' + e.message });
          }
        }
        const r = searchExact(q);
        return send(res, 200, { ...r, mode });
      }
      if (p === '/api/look.css') {
        // 界面里改外观时用它即时覆盖预览，和生成 PDF 用的是同一份 CSS
        const cfg = loadConfig();
        const q = url.searchParams;
        const css = lookCss({
          paperStyle: q.get('paperStyle') || cfg.output.paperStyle,
          font: q.get('font') || cfg.output.font,
          fontSize: Number(q.get('fontSize')) || cfg.output.fontSize,
          textColor: q.has('textColor') ? q.get('textColor') : cfg.output.textColor,
          suppFont: q.get('suppFont') || cfg.output.suppFont,
        }).css;
        res.writeHead(200, { 'content-type': 'text/css; charset=utf-8', 'cache-control': 'no-store' });
        return res.end(css);
      }
      if (p === '/api/status') return send(res, 200, environmentStatus());
      // 诊断用：自动退出计时状态
      if (p === '/api/life') {
        return send(res, 200, {
          autoClose: life.autoClose,
          subscribers: subscribers.size,
          lastClientAt: life.lastClientAt,
          startedAt: life.startedAt,
          idleMs: Date.now() - (life.lastClientAt || life.startedAt),
          closing: life.closing,
          timerAlive: !!life.timer,
          clients: [...clientInfo.values()],
          queue: { active: activeTasks, waiting: taskQueue.map((t) => t.projectId), max: queueState().max },
        });
      }
      if (p === '/api/catalog') return send(res, 200, catalogStatus());

      // 本地上传（把拖进来的视频存到磁盘，交给流水线处理）
      if (p === '/api/upload' && req.method === 'POST') {
        const name = (url.searchParams.get('name') || `video_${Date.now()}.mp4`).replace(/[\\/:*?"<>|]/g, '_');
        const dir = path.join(DATA_DIR, 'uploads');
        fs.mkdirSync(dir, { recursive: true });
        const dest = path.join(dir, name);
        await new Promise((resolve, reject) => {
          const ws = fs.createWriteStream(dest);
          req.pipe(ws);
          ws.on('finish', resolve);
          ws.on('error', reject);
          req.on('error', reject);
        });
        return send(res, 200, { ok: true, path: dest, name, size: fs.statSync(dest).size });
      }

      if (p === '/api/config' && req.method === 'GET') {
        const cfg = loadConfig();
        const { key, source } = resolveLlmKey(cfg);
        return send(res, 200, { ...cfg, llm: { ...cfg.llm, apiKey: '', _keyReady: !!key, _keySource: source, _keyMasked: maskKey(key) } });
      }
      if (p === '/api/config' && req.method === 'POST') {
        const body = await readBody(req);
        if (body.llm && body.llm.apiKey === '') delete body.llm.apiKey;
        const cfg = updateConfig(body);
        broadcast({ type: 'config-updated' });
        return send(res, 200, { ok: true, config: cfg });
      }

      if (p === '/api/install' && req.method === 'POST') {
        const body = await readBody(req);
        const ids = body.ids?.length ? body.ids : CORE_IDS;
        broadcast({ type: 'install-start', ids });
        installMany(ids, {
          log: (message) => broadcast({ type: 'log', message, scope: 'install' }),
          onProgress: (pr) =>
            broadcast({
              type: 'install-progress',
              id: pr.id,
              label: CATALOG[pr.id]?.label,
              file: pr.file,
              received: pr.received,
              total: pr.total,
              percent: pr.total ? Math.round((pr.received / pr.total) * 100) : 0,
            }),
        })
          .then((results) => broadcast({ type: 'install-done', results }))
          .catch((e) => broadcast({ type: 'install-failed', message: e.message }));
        return send(res, 200, { ok: true, started: ids });
      }
      if (p === '/api/install/cancel' && req.method === 'POST') {
        cancelDownload((await readBody(req)).id || '');
        return send(res, 200, { ok: true });
      }
      if (p === '/api/vlm/stop' && req.method === 'POST') {
        stopLocalServer();
        return send(res, 200, { ok: true });
      }

      // ---- 整章做题技巧总结
      if (p === '/api/summary/pickable' && req.method === 'GET') {
        return send(res, 200, { projects: listPickable(listProjects()) });
      }
      if (p === '/api/summary' && req.method === 'GET') {
        return send(res, 200, { items: listSummaries() });
      }
      if (p === '/api/summary' && req.method === 'POST') {
        const body = await readBody(req);
        const want = body.picks || [];
        if (!want.length) return send(res, 400, { error: '请先勾选要总结的笔记' });
        const cfg = loadConfig();
        try {
          // 按勾选把每一节的 markdown 取出来
          const picks = [];
          for (const w of want) {
            const P = projectPaths(w.projectId);
            const doc = readJson(path.join(P.work, 'doc.json'));
            if (!doc) continue;
            const st = loadState(w.projectId);
            const picked = (w.sections || [])
              .map((i) => doc.sections?.[i])
              .filter((s) => s && String(s.markdown || '').trim().length > 40);
            if (!picked.length) continue;
            picks.push({ projectId: w.projectId, title: st?.title || doc.title || w.projectId, sections: picked });
          }
          if (!picks.length) return send(res, 400, { error: '勾选的笔记没有可用内容' });
          const out = await generateSummary({
            picks,
            cfg,
            onEvent: (ev) => broadcast(ev),
          });
          return send(res, 200, { ok: true, id: out.id, markdown: out.markdown, html: out.html, sources: out.sources });
        } catch (e) {
          return send(res, 500, { error: e.message });
        }
      }
      if (p.startsWith('/api/summary/') && req.method === 'GET') {
        const one = loadSummary(p.slice('/api/summary/'.length));
        if (!one) return send(res, 404, { error: 'not found' });
        return send(res, 200, one);
      }
      // ---- 项目
      if (p === '/api/projects' && req.method === 'GET') return send(res, 200, listProjects());
      if (p === '/api/projects' && req.method === 'POST') {
        const body = await readBody(req);
        const input = (body.input || '').trim();
        if (!input) return send(res, 400, { error: '请输入视频链接或本地文件路径' });
        if (!isUrl(input) && !fs.existsSync(input)) return send(res, 400, { error: `找不到本地文件：${input}` });
        const cfg = loadConfig();
        const options = { ...body.options };
        const st = createProject({ input, options, title: body.title || '' });
        return send(res, 200, st);
      }

      const projMatch = p.match(/^\/api\/projects\/([^/]+)(\/.*)?$/);
      if (projMatch) {
        const id = projMatch[1];
        const rest = projMatch[2] || '';
        const state = loadState(id);
        if (!state) return send(res, 404, { error: '项目不存在' });
        const P = projectPaths(id);

        if (rest === '' && req.method === 'GET') {
          const snaps = readJson(path.join(P.work, 'snapshots.json')) || [];
          const media = readJson(path.join(P.work, 'media.json'));
          return send(res, 200, {
            ...state,
            running: isRunning(id),
            mediaInfo: media?.info || null,
            sourceInfo: media?.source || null,
            events: (buffers.get(id) || []).filter((e) => e.type !== 'probe-progress'),
            pointCount: (readJson(path.join(P.work, 'points.json'))?.points || []).length,
            snapshotCount: snaps.length,
            snapshots: snaps.map((s) => ({
              t: s.t,
              generation: s.generation,
              erased: s.erased,
              title: repairLatex(s.ocr?.title || ''),
              text: repairLatex(s.ocr?.text || ''),
              scene: s.ocr?.scene || '',
              image: s.imageName ? `/api/projects/${id}/figures/${s.imageName}` : null,
            })),
            doc: readJson(path.join(P.work, 'doc.json')),
          });
        }
        if (rest === '' && req.method === 'DELETE') {
          deleteProject(id);
          broadcast({ type: 'project-deleted', projectId: id });
          return send(res, 200, { ok: true });
        }
        if (rest === '/events') {
          return send(res, 200, buffers.get(id) || []);
        }
        // ---- 笔记 AI 问答
        if (rest === '/chat' && req.method === 'GET') {
          return send(res, 200, readJson(path.join(P.work, 'chat.json')) || []);
        }
        // ---- AI 补充（旁注）
        if (rest === '/supplements' && req.method === 'GET') {
          // 顺带把 AI 审校结果一起给前端（红色批注要用），省一次请求
          return send(res, 200, { ...loadSupplements(id), audit: loadAudit(id).items || [] });
        }
        if (rest === '/supplements' && req.method === 'POST') {
          const cfg = loadConfig();
          const { key } = resolveLlmKey(cfg);
          if (!key) return send(res, 400, { error: 'AI 补充需要文本模型 Key，请在「环境与模型 → 文本模型」里配置' });
          try {
            const out = await generateSupplements({ projectId: id, cfg });
            broadcast({ type: 'supplement-done', projectId: id, count: out.items.length });
            return send(res, 200, out);
          } catch (e) {
            return send(res, 500, { error: 'AI 补充失败：' + e.message });
          }
        }
        if (rest === '/chat/clear' && req.method === 'POST') {
          writeJson(path.join(P.work, 'chat.json'), []);
          return send(res, 200, { ok: true });
        }
        if (rest === '/chat' && req.method === 'POST') {
          const body = await readBody(req);
          const question = String(body.question || '').trim();
          const selection = String(body.selection || '').trim();
          const section = body.section || null;
          const images = Array.isArray(body.images) ? body.images : [];
          if (!question && !selection && !images.length) return send(res, 400, { error: '请输入问题，或先选中笔记里的内容' });
          const cfg = loadConfig();
          const state2 = loadState(id) || {};
          const imgPaths = images
            .map((f) => safeJoin(P.figures, String(f)))
            .filter((p) => p && fs.existsSync(p));
          try {
            const { answer, engine } = await answerQuestion({ question, selection, section, imgPaths, cfg, state: state2, projectId: id });
            const log = readJson(path.join(P.work, 'chat.json')) || [];
            log.push({ at: new Date().toISOString(), question, selection, images, answer, engine });
            if (log.length > 200) log.splice(0, log.length - 200);
            writeJson(path.join(P.work, 'chat.json'), log);
            return send(res, 200, { answer, engine });
          } catch (e) {
            return send(res, 500, { error: e.message });
          }
        }
        if (rest === '/run' && req.method === 'POST') {
          if (isRunning(id)) return send(res, 409, { error: '这个任务正在运行' });
          const body = await readBody(req);
          startQueued(id, body.force || {});
          return send(res, 200, { ok: true, started: true, queued: queueState().positionOf(id) });
        }
        if (rest === '/cancel' && req.method === 'POST') {
          const ok = cancelProject(id);
          return send(res, 200, { ok });
        }
        // 只重新排版（不调用模型，用于修正公式渲染/版式后快速出新 PDF）
        if (rest === '/audit' && req.method === 'POST') {
          if (isRunning(id)) return send(res, 409, { error: '这个任务正在运行' });
          const cfg = loadConfig();
          try {
            const items = await auditNotes({
              projectId: id,
              cfg,
              onEvent: (ev) => broadcast({ ...ev, projectId: id }),
              concurrency: cfg.llm.concurrency,
              bustCache: true,
            });
            // 审校结果要烧进成稿，顺手重新排版一次
            const r = await renderProject({ projectId: id, onEvent: broadcast });
            broadcast({ projectId: id, type: 'audit-done', count: items.length, html: r.htmlPath });
            return send(res, 200, { ok: true, count: items.length, items });
          } catch (e) {
            return send(res, 500, { error: e.message });
          }
        }
        if (rest === '/audit' && req.method === 'GET') {
          return send(res, 200, loadAudit(id));
        }
        if (rest === '/export-pdf' && req.method === 'POST') {
          try {
            const r = await exportPdf({
              projectId: id,
              onEvent: (ev) => broadcast({ ...ev, projectId: id }),
            });
            const name = r.pdfPath.split(/[\\/]/).pop();
            broadcast({ type: 'pdf-ready', projectId: id, name });
            return send(res, 200, { ok: true, name, url: `/api/projects/${id}/file/${encodeURIComponent(name)}` });
          } catch (e) {
            return send(res, 500, { error: e.message });
          }
        }
        if (rest === '/rerender' && req.method === 'POST') {
          if (isRunning(id)) return send(res, 409, { error: '这个任务正在运行' });
          // 审校是自动工序：新任务在流水线里就会做。老任务（出稿时还没有审校这一步）
          // 在这里补一次，这样用户不用额外点任何按钮也能拿到红标。
          try {
            const P = projectPaths(id);
            const doc = readJson(path.join(P.work, 'doc.json'));
            if (doc && !Array.isArray(doc.audit) && resolveLlmKey(loadConfig())) {
              broadcast({ projectId: id, type: 'log', message: 'AI 审校：这份成稿还没审校过，先补做一次…' });
              const cfg = loadConfig();
              await auditNotes({
                projectId: id,
                cfg,
                onEvent: (ev) => broadcast({ ...ev, projectId: id }),
                concurrency: cfg.llm.concurrency,
              });
            }
          } catch (e) {
            broadcast({ projectId: id, type: 'log', level: 'warn', message: `AI 审校跳过：${e.message}` });
          }
          broadcast({ projectId: id, type: 'log', message: '▶ 重新排版（不重新识别）' });
          renderProject({ projectId: id, onEvent: broadcast })
            .then((r) => {
              broadcast({ projectId: id, type: 'log', message: `排版完成：${r.pdfPath ? path.basename(r.pdfPath) : '网页版已更新（PDF 需点「导出 PDF」）'}`, level: 'ok' });
              broadcast({ projectId: id, type: 'rerender-done', pdf: r.pdfPath, html: r.htmlPath });
            })
            .catch((e) => broadcast({ projectId: id, type: 'failed', message: e.message }));
          return send(res, 200, { ok: true, started: true });
        }
        if (rest.startsWith('/figures/')) {
          const abs = safeJoin(P.figures, rest.slice('/figures/'.length));
          if (!abs) return send(res, 400, { error: 'bad path' });
          return serveStatic(res, abs);
        }
        // 成稿里 @font-face 用的是相对路径 fonts/xxx.ttf，
        // iframe 通过 /api/projects/<id>/html 加载，所以要在这里也能取到字体
        if (rest.startsWith('/fonts/')) {
          const abs = safeJoin(path.join(P.out, 'fonts'), rest.slice('/fonts/'.length));
          if (!abs) return send(res, 400, { error: 'bad path' });
          return serveStatic(res, abs);
        }
        if (rest.startsWith('/file/')) {
          const name = decodeURIComponent(rest.slice('/file/'.length));
          const abs = safeJoin(P.out, name);
          if (!abs) return send(res, 400, { error: 'bad path' });
          if (url.searchParams.get('download') !== null && fs.existsSync(abs)) {
            res.writeHead(200, {
              'content-type': MIME[path.extname(abs).toLowerCase()] || 'application/octet-stream',
              'content-disposition': `attachment; filename="${encodeURIComponent(path.basename(abs))}"`,
            });
            return fs.createReadStream(abs).pipe(res);
          }
          return serveStatic(res, abs);
        }
        if (rest === '/html') {
          const f = path.join(P.out, 'notes.html');
          if (!fs.existsSync(f)) return send(res, 404, { error: '尚未生成' });
          res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
          return fs.createReadStream(f).pipe(res);
        }
        // 笔记章节：用和 PDF 完全相同的渲染管线生成 HTML，界面直接展示，避免两边排版不一致
        if (rest === '/sections') {
          const docPath = path.join(P.work, 'doc.json');
          if (!fs.existsSync(docPath)) return send(res, 200, []);
          const doc = JSON.parse(fs.readFileSync(docPath, 'utf8'));
          const out = (doc.sections || [])
            .map((s) => ({
              index: s.index,
              // 标题里可能带 $...$（例如「洛朗展开：以 $f(z)=\dfrac{z-1}{z-2}$ 为例」）。
              // title 保留原文（搜索/复制用），titleText 去掉定界符，titleHtml 是排好版的
              // （界面显示用 titleHtml，否则会把 \dfrac{...} 这种源码露出来）。
              title: String(s.title || ''),
              titleText: String(s.title || '').replace(/\$/g, ''),
              titleHtml: textToHtml(titleMath(s.title), { inlineMath: true }),
              start: s.start,
              end: s.end,
              html: mdToHtml(String(s.markdown || '').replace(/^#{1,3}\s*.+$/m, '').trim()),
              images: (s.images || []).map((i) => `/api/projects/${id}/figures/${i.relPath}`),
              chars: String(s.markdown || '').length,
            }))
            .filter((s) => s.chars > 20 || s.images.length);
          return send(res, 200, {
            title: doc.title,
            overview: doc.overview ? mdToHtml(doc.overview) : '',
            objectives: (doc.objectives || []).map((o) => mdToHtml(String(o)).replace(/^<p>|<\/p>\s*$/g, '')),
            formulas: doc.formulas ? mdToHtml(doc.formulas) : '',
            glossary: doc.glossary ? mdToHtml(doc.glossary) : '',
            quiz: doc.quiz ? mdToHtml(doc.quiz) : '',
            sections: out,
            // 板书全时间线：原本是 PDF 的附录，现在放在「笔记章节」里看
            board: (doc.timeline || []).map((x) => ({
              t: x.t,
              generation: x.generation,
              erased: !!x.erased,
              title: x.title || '',
              text: x.text || '',
              image: x.relPath ? `/api/projects/${id}/figures/${x.relPath}` : null,
            })),
          });
        }
        return send(res, 404, { error: 'not found' });
      }

      // ---- 静态资源
      if (p.startsWith('/api/assets/')) {
        const abs = safeJoin(path.join(DATA_DIR, 'assets'), p.slice('/api/assets/'.length));
        return abs ? serveStatic(res, abs) : send(res, 400, { error: 'bad path' });
      }
      if (p.startsWith('/vendor/')) {
        const abs = safeJoin(path.join(PUBLIC_DIR, 'vendor'), p.slice('/vendor/'.length));
        return abs ? serveStatic(res, abs) : send(res, 400, { error: 'bad path' });
      }
      if (p === '/' || p === '/index.html') return serveStatic(res, path.join(PUBLIC_DIR, 'index.html'));
      const abs = safeJoin(PUBLIC_DIR, p.slice(1));
      if (abs && fs.existsSync(abs)) return serveStatic(res, abs);
      return send(res, 404, { error: 'not found' });
    } catch (e) {
      return send(res, 500, { error: e.message });
    }
  });

  return new Promise((resolve, reject) => {
    // 端口被占用时把错误交给调用方（main.mjs 会自动换一个端口重试），
    // 否则会变成未捕获的 'error' 事件，用户看到一屏堆栈。
    server.once('error', reject);
    server.listen(port, host, () => {
      server.removeListener('error', reject);
      if (autoClose) {
        // 没有任何页面连上来（比如打开了却没加载成功）→ 3 分钟后自动退出；
        // 曾经有页面连过、现在都关掉了 → 45 秒后自动退出（留点余量给刷新和网络抖动）。
        life.timer = setInterval(() => {
          if (life.closing) return;
          const ref = life.lastClientAt || life.startedAt;
          const limit = life.lastClientAt ? 45_000 : 180_000;
          if (subscribers.size > 0 || Date.now() - ref <= limit) return;
          // 还有任务在跑就先别退，等它跑完再退（别让用户关掉页面就丢任务）
          const busy = [...buffers.keys()].some((pid) => isRunning(pid));
          if (busy) {
            life.lastClientAt = Date.now(); // 视为“还在忙”，过一会儿再看
            return;
          }
          shutdown(life.lastClientAt ? '所有页面都已关闭' : '长时间没有任何页面连接');
        }, 3000);
        life.timer.unref?.();
      }
      resolve({ server, port: server.address().port, url: `http://${host}:${server.address().port}`, shutdown, life });
    });
  });
}

export { broadcast };

/** 诊断用：当前有多少个页面连着、以及自动退出计时状态 */
export function serverStats() {
  return { subscribers: subscribers.size };
}
