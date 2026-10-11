// 流水线编排：下载 → 抽音频 → 逐帧追踪板书 → 识别板书 → 语音识别 → 整理成文 → 出 PDF。
import fs from 'node:fs';
import path from 'node:path';
import { probeMedia, downloadVideo, extractAudio, isUrl, readInfoJson } from './ingest.mjs';
import { transcribe, punctuate, asrAssets } from './asr.mjs';
import { probeVideo } from './detect.mjs';
import { readBoardImage, vlmAssets, stopLocalServer } from './vision.mjs';
import { synthesize, fmtTime } from './fusion.mjs';
import { auditNotes } from './audit.mjs';
import { grabFrame, run, ffmpeg } from './proc.mjs';
import { buildHtml, buildMarkdown, htmlToPdf, ensureKatexAssets, ASSET_DIR } from './render.mjs';
import { loadConfig } from './config.mjs';
import { projectPaths, loadState, patchState, readJson, writeJson } from './project.mjs';
import { humanSize, FONTS_DIR } from './paths.mjs';

export const STAGES = [
  { id: 'prepare', label: '获取视频', desc: '下载或读取视频文件' },
  { id: 'audio', label: '听懂课程', desc: '提取音轨并转写讲稿' },
  { id: 'visual', label: '逐帧追踪板书', desc: '扫描画面变化，抓取每一屏完整板书' },
  { id: 'read', label: '识别板书内容', desc: '视觉模型读取黑板上的字迹与公式' },
  { id: 'think', label: '组织笔记', desc: '对齐讲稿与板书，整理成结构化笔记' },
  { id: 'audit', label: '审校纠错', desc: '复核公式与结论，实质错误用红标指出' },
  { id: 'render', label: '排版出稿', desc: '生成网页版与 Markdown（PDF 按需导出）' },
];

/** 归一化板书文字，用于判断「这一屏有没有比上一屏多出内容」。 */
function normBoardText(s) {
  return String(s || '')
    .replace(/[\s\u3000]/g, '')
    .replace(/[，。、；：！？,.;:!?（）()\[\]【】《》"'`~—\-–_]/g, '')
    .toLowerCase();
}

/** 字符二元组相似度，用于判断两屏板书是不是同一内容的不同识别结果。 */
function bigramSim(a, b) {
  if (!a || !b) return 0;
  if (a === b) return 1;
  const grams = (s) => {
    const set = new Set();
    for (let i = 0; i < s.length - 1; i++) set.add(s.slice(i, i + 2));
    return set;
  };
  const A = grams(a);
  const B = grams(b);
  let inter = 0;
  for (const g of A) if (B.has(g)) inter++;
  const union = A.size + B.size - inter;
  return union ? inter / union : 0;
}

/** 同一块板书内，如果新抓拍的内容已被上一次保留的内容完全包含（或高度相似），就标记为重复。 */
export function markDuplicates(snapshots) {
  const lastByGen = new Map();
  for (const s of snapshots) {
    const text = normBoardText(s.ocr?.text);
    s.dup = false;
    if (!text || text.length < 4) {
      s.dup = true; // 没识别出内容的一屏不必进入笔记
      continue;
    }
    const prev = lastByGen.get(s.generation);
    if (prev) {
      const contained = prev.length >= text.length && prev.includes(text);
      const similar = Math.abs(prev.length - text.length) < Math.max(prev.length, text.length) * 0.25 && bigramSim(prev, text) > 0.92;
      if (contained || similar) s.dup = true;
    }
    if (!s.dup) lastByGen.set(s.generation, text);
  }
  return snapshots;
}

const running = new Map();

export function isRunning(id) {
  return running.has(id);
}

export function cancelProject(id) {
  const c = running.get(id);
  if (c) {
    c.abort();
    return true;
  }
  return false;
}

/**
 * 执行整条流水线。
 * @param {object} opts { projectId, onEvent, force }
 */
export async function runPipeline({ projectId, onEvent = () => {}, force = {} }) {
  const cfg = loadConfig();
  const state = loadState(projectId);
  if (!state) throw new Error('项目不存在');
  const P = projectPaths(projectId);
  const controller = new AbortController();
  running.set(projectId, controller);
  const signal = controller.signal;
  const emit = (e) => {
    try {
      onEvent({ projectId, at: Date.now(), ...e });
    } catch {}
  };

  const markStage = (id, status, extra = {}) => {
    patchState(projectId, { stage: id, stages: { [id]: { status, at: new Date().toISOString(), ...extra } } });
    emit({ type: 'stage', stage: id, status, ...extra });
  };

  try {
    // ---------------------------------------------------------- 1. 获取视频
    markStage('prepare', 'running');
    let mediaFile = null;
    let mediaInfo = null;
    const mediaJson = path.join(P.work, 'media.json');
    const cachedMedia = !force.prepare && readJson(mediaJson);
    if (cachedMedia && fs.existsSync(cachedMedia.file)) {
      mediaFile = cachedMedia.file;
      mediaInfo = cachedMedia.info;
      emit({ type: 'log', message: '复用已下载的视频' });
    } else {
      const input = state.input;
      if (isUrl(input)) {
        emit({ type: 'log', message: `开始下载：${input}` });
        mediaFile = await downloadVideo({
          url: input,
          outDir: P.media,
          quality: cfg.download.quality,
          cookiesFromBrowser: cfg.download.cookiesFromBrowser,
          section: state.options?.section || cfg.download.section || '',
          onEvent: emit,
          signal,
        });
      } else {
        if (!fs.existsSync(input)) throw new Error(`找不到本地文件：${input}`);
        mediaFile = input;
      }
      mediaInfo = await probeMedia(mediaFile);
      const info = isUrl(state.input) ? readInfoJson(P.media) : null;
      writeJson(mediaJson, { file: mediaFile, info: mediaInfo, source: info });
      if (info?.title) patchState(projectId, { title: state.title || info.title, sourceInfo: info });
    }
    const srcInfo = readJson(mediaJson)?.source || null;
    emit({
      type: 'media-info',
      info: mediaInfo,
      file: path.basename(mediaFile),
      sizeText: humanSize(mediaInfo.size),
      durationText: fmtTime(mediaInfo.duration),
      title: srcInfo?.title || state.title || '',
    });
    emit({ type: 'log', message: `视频就绪：${mediaInfo.width}×${mediaInfo.height}，时长 ${fmtTime(mediaInfo.duration)}` });
    markStage('prepare', 'done', { duration: mediaInfo.duration });

    // ---------------------------------------------------------- 2. 音频 → 讲稿
    markStage('audio', 'running');
    const wav = path.join(P.work, 'audio.wav');
    let transcript = { segments: [], text: '' };
    if (!cfg.asr.enabled || !mediaInfo.hasAudio) {
      emit({ type: 'log', level: 'warn', message: mediaInfo.hasAudio ? '已跳过语音识别' : '视频没有音轨，仅使用板书内容' });
    } else {
      await extractAudio({ video: mediaFile, outFile: wav, onEvent: emit, signal });
      const a = asrAssets();
      if (!a.ready) {
        emit({ type: 'log', level: 'warn', message: '语音识别组件未安装，跳过讲解内容（可稍后在设置里安装后重跑）' });
      } else {
        transcript = await transcribe({
          wav,
          workDir: P.work,
          duration: mediaInfo.duration,
          options: { threads: cfg.asr.threads, chunkMinutes: cfg.asr.chunkMinutes },
          onEvent: emit,
          signal,
        });
        if (cfg.asr.punctuate !== false) {
          try {
            transcript = await punctuate({ transcript, workDir: P.work, onEvent: emit, signal });
          } catch (e) {
            emit({ type: 'log', level: 'warn', message: `标点补全跳过：${e.message}` });
          }
        }
      }
    }
    markStage('audio', 'done', { segments: transcript.segments?.length || 0 });

    // ---------------------------------------------------------- 3. 追踪板书
    markStage('visual', 'running');
    const pointsFile = path.join(P.work, 'points.json');
    let vis = !force.visual && readJson(pointsFile);
    if (!vis) {
      emit({ type: 'log', message: '开始扫描画面，寻找每一屏完整板书…' });
      const probe = await probeVideo({
        video: mediaFile,
        width: mediaInfo.width,
        height: mediaInfo.height,
        duration: mediaInfo.duration,
        options: cfg.capture,
        onEvent: emit,
        signal,
      });
      emit({
        type: 'log',
        message: `扫描完成：识别出 ${probe.generations.length} 块板书、${probe.points.length} 个抓拍时刻`,
      });
      vis = { points: probe.points, generations: probe.generations, meta: probe.meta };
      writeJson(pointsFile, vis);
    } else {
      emit({ type: 'log', message: `复用板书追踪结果（${vis.points.length} 个抓拍时刻）` });
    }
    emit({ type: 'board-timeline', generations: vis.generations, points: vis.points.map((p) => ({ t: p.t, generation: p.generation, reason: p.reason })) });
    markStage('visual', 'done', { points: vis.points.length, generations: vis.generations.length });

    // ---------------------------------------------------------- 4. 识别板书
    markStage('read', 'running');
    const snapFile = path.join(P.work, 'snapshots.json');
    let snapshots = force.read ? [] : readJson(snapFile) || [];
    const doneTimes = new Set(snapshots.map((s) => s.t));
    const gens = new Map(vis.generations.map((g) => [g.index, g]));
    const total = vis.points.length;
    let doneCount = snapshots.length;
    for (const p of vis.points) {
      if (signal.aborted) throw new Error('已取消');
      if (doneTimes.has(p.t)) {
        emit({ type: 'read-progress', percent: Math.round((doneCount / total) * 100), done: doneCount, total });
        continue;
      }
      const name = `board_${String(p.index).padStart(4, '0')}_${String(Math.floor(p.t)).padStart(6, '0')}.jpg`;
      const img = path.join(P.figures, name);
      try {
        const g = gens.get(p.generation) || {};
        // 空白画面（刚擦干净、或老师占满画面）不必浪费视觉模型
        if ((p.inkTotal ?? 0) < 0.0015) {
          emit({ type: 'log', message: `${fmtTime(p.t)} 画面几乎空白，跳过识别` });
          doneCount++;
          emit({ type: 'read-progress', percent: Math.round((doneCount / total) * 100), done: doneCount, total });
          continue;
        }
        if (!fs.existsSync(img)) {
          await grabFrame(mediaFile, p.t, img, { crop: p.roi || undefined, width: cfg.capture.imageWidth });
        }
        let ocr = { scene: 'unknown', title: '', text: '', layout: '', confidence: 'low', skipped: true };
        const vlm = vlmAssets(cfg.vlm.modelId);
        const canRead = cfg.vlm.mode === 'openai-compatible' || vlm.ready;
        if (canRead) {
          ocr = await readBoardImage({ imagePath: img, cfg: cfg.vlm, onEvent: emit, signal });
        } else {
          ocr = { ...ocr, text: '', note: '视觉模型未安装' };
        }
        const snap = {
          index: p.index,
          t: p.t,
          generation: p.generation,
          reason: p.reason,
          erased: !!g.erased,
          generationReason: g.reason || '',
          imagePath: img,
          imageName: name,
          roi: p.roi || null,
          ocr,
        };
        snapshots.push(snap);
        doneCount++;
        markDuplicates(snapshots);
        writeJson(snapFile, snapshots);
        if (!snap.dup) {
          emit({
            type: 'board-ready',
            snapshot: {
              t: snap.t,
              generation: snap.generation,
              erased: snap.erased,
              title: ocr.title,
              text: ocr.text,
              scene: ocr.scene,
              image: `/api/projects/${projectId}/figures/${name}`,
            },
            percent: Math.round((doneCount / total) * 100),
            done: doneCount,
            total,
          });
        }
        if (!ocr.text || ocr.text.trim().length < 2) {
          emit({ type: 'log', message: `${fmtTime(p.t)} 这一屏没有识别到板书文字（${ocr.scene || '未知'}）` });
        } else if (snap.dup) {
          emit({ type: 'log', message: `${fmtTime(p.t)} 与上一屏内容相同，已自动去重` });
        }
      } catch (e) {
        if (signal.aborted) throw new Error('已取消');
        emit({ type: 'log', level: 'error', message: `${fmtTime(p.t)} 识别失败：${e.message}` });
      }
    }
    snapshots.sort((a, b) => a.t - b.t);
    markDuplicates(snapshots);
    writeJson(snapFile, snapshots);
    stopLocalServer(); // 识别完成，释放显存
    const usable = snapshots.filter((s) => !s.dup && (s.ocr?.text || '').trim().length > 1);
    emit({
      type: 'log',
      message: `板书识别完成：${usable.length} 屏有效内容（另有 ${snapshots.length - usable.length} 屏无新增内容，已自动去重）`,
    });
    if (!usable.length && !(transcript.segments || []).length) {
      throw new Error('既没有识别到板书内容，也没有转写出语音内容，无法生成笔记');
    }
    markStage('read', 'done', { snapshots: snapshots.length, usable: usable.length });

    // ---------------------------------------------------------- 5. 组织笔记
    markStage('think', 'running');
    const metaForLlm = {
      title: state.title || srcInfo?.title || '课程笔记',
      // 建任务时填的课程名优先，其次用设置里的默认值
      course: state.options?.courseName || cfg.output.courseName || '',
    };
    const doc = await synthesize({
      transcript,
      snapshots: snapshots.filter((s) => !s.dup),
      duration: mediaInfo.duration,
      meta: metaForLlm,
      cfg,
      cacheDir: path.join(P.work, 'notes'),
      onEvent: emit,
      signal,
      concurrency: cfg.llm.concurrency,
      bustCache: !!force.think,
    });
    // 章节标题在界面上是纯文本显示的，去掉里面的 $ 定界符（正文里的公式不受影响，
    // PDF 的标题会由同样的文本生成，读起来一样自然）
    for (const s of doc.sections || []) {
      if (s.title) s.title = String(s.title).replace(/\$/g, '');
    }
    writeJson(path.join(P.work, 'doc.json'), doc);
    markStage('think', 'done', { sections: doc.sections.length });

    // ---------------------------------------------------------- 5.5 AI 审校
    // 出稿前先复核一遍：笔记里如果留下根本性错误（公式错、结论错、条件缺失），
    // 用红色感叹号标出来。误报比漏报更伤信任，所以只报「实质错误」。
    markStage('audit', 'running');
    try {
      const issues = await auditNotes({
        projectId,
        cfg,
        onEvent: emit,
        signal,
        concurrency: cfg.llm.concurrency,
        bustCache: !!force.think,
      });
      markStage('audit', 'done', { issues: issues.length });
    } catch (e) {
      // 审校失败不该拖垮整个流程（比如 Key 失效），记一条日志继续出稿
      emit({ type: 'log', level: 'warn', message: `AI 审校跳过：${e.message}` });
      markStage('audit', 'done', { issues: 0, skipped: true });
    }

    // ---------------------------------------------------------- 6. 排版出稿
    markStage('render', 'running');
    const rendered = await renderProject({
      projectId,
      onEvent: emit,
      docIn: doc,
      mediaInfoIn: mediaInfo,
      transcriptIn: transcript,
      stateIn: state,
      cfgIn: cfg,
      makePdf: false, // 首次生成不出 PDF，等用户在界面上点「导出 PDF」
    });
    patchState(projectId, {
      stage: 'done',
      title: doc.title || state.title,
      output: { html: rendered.htmlPath, md: rendered.mdPath, pdf: rendered.pdfPath, docTitle: doc.title },
      stats: {
        snapshots: snapshots.length,
        usable: usable.length,
        sections: doc.sections.length,
        erased: new Set(doc.timeline.filter((t) => t.erased).map((t) => t.generation)).size,
      },
    });
    markStage('render', 'done', { pdf: rendered.pdfPath });
    emit({
      type: 'done',
      pdf: rendered.pdfPath,
      html: rendered.htmlPath,
      md: rendered.mdPath,
      title: doc.title,
      stats: { snapshots: snapshots.length, usable: usable.length, sections: doc.sections.length },
    });
    return { ...rendered, doc };
  } catch (e) {
    patchState(projectId, { error: e.message });
    emit({ type: 'failed', message: e.message, aborted: signal.aborted });
    throw e;
  } finally {
    running.delete(projectId);
  }
}

/**
 * 只做排版：从 work/doc.json 重建 HTML / Markdown / PDF，
 * 不调用任何模型、不重新识别。改了排版样式或公式规范化规则后用它即可。
 */
export async function renderProject({ projectId, onEvent = () => {}, docIn, mediaInfoIn, transcriptIn, stateIn, cfgIn, makePdf = null } = {}) {
  const P = projectPaths(projectId);
  const cfg = cfgIn || loadConfig();
  const state = stateIn || loadState(projectId) || { id: projectId, input: '' };
  const doc = docIn || readJson(path.join(P.work, 'doc.json'));
  if (!doc || !doc.sections) throw new Error('还没有整理好的笔记内容，请先运行一次完整流程');
  const media = mediaInfoIn || readJson(path.join(P.work, 'media.json'))?.info || {};
  const transcript = transcriptIn || readJson(path.join(P.work, 'transcript.json')) || { segments: [] };

  ensureKatexAssets();
  const outFigures = path.join(P.out, 'figures');
  fs.mkdirSync(outFigures, { recursive: true });
  // 笔记字体（可选）：把字体文件放到 out/fonts/ 下，HTML 用相对路径引用，
  // 这样 iframe 预览和 Edge 打印（file://）都能加载到，不会踩跨域问题。
  let fontFile = '';
  if (cfg.output.font === 'wenkai' || cfg.output.suppFont === 'wenkai') {
    const src = path.join(FONTS_DIR, 'lxgw-wenkai-regular.ttf');
    if (fs.existsSync(src)) {
      const outFonts = path.join(P.out, 'fonts');
      fs.mkdirSync(outFonts, { recursive: true });
      fs.copyFileSync(src, path.join(outFonts, 'lxgw-wenkai-regular.ttf'));
      fontFile = 'lxgw-wenkai-regular.ttf';
    }
  }
  const relNames = [
    ...doc.sections.flatMap((s) => (s.images || []).map((i) => i.relPath)),
    ...(doc.timeline || []).map((i) => i.relPath),
  ].filter(Boolean);
  for (const name of new Set(relNames)) {
    const src = path.join(P.figures, name);
    if (fs.existsSync(src)) fs.copyFileSync(src, path.join(outFigures, name));
  }
  const srcInfo = readJson(path.join(P.work, 'media.json'))?.source;
  const meta = {
    title: doc.title || state.title || '课程笔记',
    course: state.options?.courseName || cfg.output.courseName || '',
    paper: cfg.output.paper,
    paperStyle: cfg.output.paperStyle || 'white',
    font: cfg.output.font || 'system',
    fontSize: cfg.output.fontSize || 10.8,
    textColor: cfg.output.textColor || '',
    suppFont: cfg.output.suppFont || cfg.output.font || 'system',
    fontFile,
    source: isUrl(state.input) ? state.input : '',
    durationText: fmtTime(media.duration || 0),
    transcriptChars: (transcript.segments || []).reduce((a, s) => a + s.text.length, 0),
    transcript: cfg.output.includeTranscript ? transcript.segments || [] : [],
  };
  if (srcInfo?.title && !state.title) meta.title = doc.title || srcInfo.title;
  const relAssets = path.relative(P.out, ASSET_DIR).replace(/\\/g, '/');
  const htmlPath = path.join(P.out, 'notes.html');
  const html = buildHtml(doc, {
    meta,
    relativeAssets: relAssets,
    includeTranscript: !!cfg.output.includeTranscript,
    includeBoardImages: !!cfg.output.includeBoardImages,
    includeBoardTimeline: !!cfg.output.includeBoardTimeline,
  });
  fs.writeFileSync(htmlPath, html, 'utf8');
  const mdPath = path.join(P.out, 'notes.md');
  fs.writeFileSync(mdPath, buildMarkdown(doc, meta), 'utf8');
  const safeTitle = (doc.title || '课程笔记').replace(/[\\/:*?"<>|]/g, '_').slice(0, 60);
  // 是否生成 PDF：
  //   makePdf=true/false 明确指定；
  //   不指定时——已经有 PDF（重新排版要跟着更新）或用户开了「自动导出」才生成。
  //   默认不生成，等用户点「导出 PDF」。
  const wantPdf = makePdf === null ? !!(state.output?.pdf || cfg.output.autoPdf) : !!makePdf;
  let pdfPath = state.output?.pdf || null;
  if (wantPdf) {
    // 清理旧的 PDF（标题可能变了）
    for (const f of fs.readdirSync(P.out)) if (f.endsWith('.pdf')) fs.rmSync(path.join(P.out, f), { force: true });
    try {
      pdfPath = await htmlToPdf({ htmlPath, pdfPath: path.join(P.out, `${safeTitle}.pdf`), onEvent });
    } catch (e) {
      pdfPath = null;
      onEvent({ type: 'log', level: 'error', message: `PDF 生成失败：${e.message}（HTML 已生成，可用浏览器打印）` });
    }
  }
  patchState(projectId, { stage: 'done', output: { html: htmlPath, md: mdPath, pdf: pdfPath, docTitle: doc.title } });
  return { pdfPath, htmlPath, mdPath, doc };
}

/** 只重跑「组织笔记 + 排版」两步（改了提示词或模型后快速重试）。 */
export async function rerunNotes({ projectId, onEvent = () => {} }) {
  return runPipeline({ projectId, onEvent, force: { think: true, render: true } });
}

/** 按需导出 PDF：只重排版（不调用模型），并强制生成 PDF。 */
export async function exportPdf({ projectId, onEvent = () => {} }) {
  onEvent({ type: 'log', message: '正在导出 PDF…' });
  const r = await renderProject({ projectId, onEvent, makePdf: true });
  if (!r.pdfPath) throw new Error('PDF 生成失败，请看运行日志');
  return r;
}

export { stopLocalServer, ffmpeg, run };
