// 命令行入口。
//   node app/main.mjs serve [--port 7788] [--no-open]   # 启动界面
//   node app/main.mjs run <链接或文件> [--out 目录]      # 无界面直接生成
//   node app/main.mjs doctor                           # 检查环境
//   node app/main.mjs fetch [资源id...]                 # 安装依赖资源
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { installMany, CORE_IDS, catalogStatus } from './lib/download.mjs';
import { humanSize } from './lib/paths.mjs';

const [cmd = 'serve', ...rest] = process.argv.slice(2);

// 控制台窗口标题（bat 里不能写中文，会因编码被 cmd 解析坏，所以在这里设置）
try {
  process.title = '课程笔记工坊';
} catch {}

/**
 * 核心模块用动态导入：换到别人电脑上时，如果还没装 marked/katex，
 * 这里能给出人话提示，而不是丢一堆 MODULE_NOT_FOUND。
 */
async function loadCore() {
  try {
    const [server, pipeline, project] = await Promise.all([
      import('./lib/server.mjs'),
      import('./lib/pipeline.mjs'),
      import('./lib/project.mjs'),
    ]);
    return { ...server, ...pipeline, ...project };
  } catch (e) {
    if (e && e.code === 'ERR_MODULE_NOT_FOUND') {
      console.error('');
      console.error('  缺少运行依赖（排版用的 marked / katex 还没装）。');
      console.error('  解决办法：双击「安装组件.bat」，或在本目录执行下面这条命令：');
      console.error('      npm install --omit=dev');
      console.error('');
      process.exit(1);
    }
    throw e;
  }
}

function flag(name, def = null) {
  const i = rest.indexOf('--' + name);
  if (i >= 0) {
    const v = rest[i + 1];
    if (v === undefined || v.startsWith('--')) return true;
    // 把 --open false / --open 0 / --open no 这类写法当成「关」
    if (v === 'false' || v === '0' || v === 'no') return false;
    if (v === 'true' || v === '1' || v === 'yes') return true;
    return v;
  }
  return def;
}

async function cmdServe() {
  const core = await loadCore();
  const port = Number(flag('port', process.env.PORT || 7788));
  const host = String(flag('host', '127.0.0.1'));
  // 默认：所有页面关掉后自己退出（把黑窗口也一起关掉）。
  // 想让它一直挂着（比如给局域网里别人用），加 --keep-open。
  const autoClose = flag('keep-open', false) === true ? false : true;
  const { url } = await core.startServer({
    port,
    host,
    autoClose,
    onShutdown: () => core.stopLocalServer?.(),
  });
  const st = core.environmentStatus();
  console.log('');
  console.log('  ╭──────────────────────────────────────────────╮');
  console.log('  │            课程笔记工坊 已启动               │');
  console.log('  ╰──────────────────────────────────────────────╯');
  console.log(`  本机访问：${url}`);
  if (host === '0.0.0.0' || host === '::') {
    for (const [name, addrs] of Object.entries(os.networkInterfaces())) {
      for (const a of addrs || []) {
        if (a.family === 'IPv4' && !a.internal) console.log(`  同一局域网内其他人访问：http://${a.address}:${port}   （网卡：${name}）`);
      }
    }
    console.log('  ⚠ 局域网共享时没有密码保护，别人可以使用你的模型 Key 并看到你的任务，请只在可信网络里这样开。');
  }
  console.log(`  运行环境：ffmpeg ${st.ffmpeg ? '✓' : '✗'}   语音识别 ${st.asr.ready ? '✓' : '✗'}   视觉模型 ${st.vlm.some((v) => v.ready) ? '✓' : '✗'}   PDF 引擎 ${st.edge ? '✓' : '✗'}   文本模型 ${st.llm.ready ? '✓' : '✗'}`);
  if (!st.coreInstalled) {
    console.log('  ⚠ 部分组件尚未安装，可在网页右侧「环境与模型」里一键安装。');
    console.log(`    也可以直接运行：node app/fetch-tools.mjs --all`);
  }
  if (!st.llm.ready) {
    console.log('  ⚠ 还没有配置文本模型 Key，请在网页「环境与模型 → 文本模型」里填入（DeepSeek 或任意 OpenAI 兼容接口）。');
  }
  console.log('  关掉所有页面后本程序会自动退出（黑窗口也会一起关闭）；');
  console.log('  想让它一直开着（例如分享给局域网里的人），用：node app/main.mjs serve --keep-open');
  console.log('  也可以随时在本窗口按 Ctrl+C 手动退出。');
  console.log('');
  if (flag('open', true) !== false) {
    try {
      spawn('cmd', ['/c', 'start', '', url], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
    } catch {}
  }
}

async function cmdRun() {
  const core = await loadCore();
  const input = rest.find((a) => !a.startsWith('--'));
  if (!input) {
    console.error('用法：node app/main.mjs run <视频链接或文件路径>');
    process.exit(1);
  }
  const outDir = flag('out', null);
  const st = core.createProject({ input, options: {} });
  console.log(`任务已创建：${st.id}`);
  const onEvent = (e) => {
    if (e.type === 'log') console.log(`  · ${e.message}`);
    else if (e.type === 'stage') console.log(`\n[${e.stage}] ${e.status}`);
    else if (e.type === 'probe-progress') process.stdout.write(`\r  画面扫描 ${e.percent}%（已抓 ${e.snapshots} 屏）   `);
    else if (e.type === 'read-progress') process.stdout.write(`\r  板书识别 ${e.percent}%（${e.done}/${e.total}）   `);
    else if (e.type === 'asr-progress') process.stdout.write(`\r  语音识别 ${e.percent}%   `);
    else if (e.type === 'note-progress') process.stdout.write(`\r  整理笔记 ${e.percent}%   `);
    else if (e.type === 'done') console.log(`\n\n完成！PDF：${e.pdf}`);
    else if (e.type === 'failed') console.error(`\n失败：${e.message}`);
  };
  const r = await core.runPipeline({ projectId: st.id, onEvent });
  if (outDir && r.pdfPath) {
    fs.mkdirSync(outDir, { recursive: true });
    const target = path.join(outDir, path.basename(r.pdfPath));
    fs.copyFileSync(r.pdfPath, target);
    console.log(`已复制到：${target}`);
  }
}

async function cmdDoctor() {
  const core = await loadCore();
  const st = core.environmentStatus();
  const line = (ok, label, hint = '') => console.log(`  ${ok ? '[✓]' : '[ ]'} ${label}${!ok && hint ? '  → ' + hint : ''}`);
  console.log('\n环境检查');
  line(st.ffmpeg, 'FFmpeg 解码器', 'node app/fetch-tools.mjs ffmpeg');
  line(st.ytdlp, 'yt-dlp 下载器', 'node app/fetch-tools.mjs ytdlp');
  line(st.asr.ready, '语音识别（sherpa-onnx + SenseVoice）', 'node app/fetch-tools.mjs sherpa asr-sensevoice');
  line(st.llamaServer, 'llama.cpp 推理引擎', 'node app/fetch-tools.mjs llamacpp-vulkan');
  console.log('  视觉模型：');
  for (const v of st.vlm) console.log(`    ${v.ready ? '[✓]' : '[ ]'} ${v.label} (${v.id})`);
  line(st.edge, 'Edge（生成 PDF）');
  line(st.llm.ready, `文本模型 Key（${st.llm.source}）`, '在界面设置里填写，或使用 DSH 已保存的 DeepSeek Key');
  console.log('\n磁盘占用：');
  for (const r of catalogStatus()) {
    console.log(`  ${r.installed ? '[✓]' : '[ ]'} ${r.id.padEnd(18)} ${humanSize(r.currentSize).padStart(9)} / ${humanSize(r.size).padStart(9)}  ${r.label}`);
  }
  console.log('');
}

async function cmdFetch() {
  const ids = rest.filter((a) => !a.startsWith('--'));
  const list = ids.length ? ids : CORE_IDS;
  const results = await installMany(list, {
    log: (m) => console.log(m),
    onProgress: (p) => {
      const pct = p.total ? Math.round((p.received / p.total) * 100) : 0;
      if (pct % 5 === 0) process.stdout.write(`\r  ${(CATALOG_LABEL(p.id) || p.id).slice(0, 20)} ${pct}%   `);
    },
  });
  function CATALOG_LABEL(id) {
    return catalogStatus().find((r) => r.id === id)?.label;
  }
  console.log('');
  for (const r of results) console.log(`  ${r.ok ? (r.skipped ? '跳过' : '完成') : '失败'}  ${r.id}${r.error ? ' ' + r.error : ''}`);
}

/**
 * 维护命令：把已生成项目里的「裸公式」补上 $...$（修旧数据用，不调用任何模型）。
 *   node app/main.mjs fix-latex            → 处理所有项目
 *   node app/main.mjs fix-latex <项目id>    → 只处理一个项目
 */
async function cmdFixLatex() {
  const core = await loadCore();
  const { repairLatex } = await import('./lib/latex.mjs');
  const ids = rest.filter((a) => !a.startsWith('--'));
  const list = ids.length ? ids : core.listProjects().map((p) => p.id);
  let totalFiles = 0;
  for (const id of list) {
    const P = core.projectPaths(id);
    let changed = 0;
    const fixDoc = (d) => {
      if (!d) return d;
      const before = JSON.stringify(d);
      if (d.overview) d.overview = repairLatex(d.overview);
      if (Array.isArray(d.objectives)) d.objectives = d.objectives.map((o) => repairLatex(String(o)));
      if (d.formulas) d.formulas = repairLatex(d.formulas);
      if (d.glossary) d.glossary = repairLatex(d.glossary);
      if (d.quiz) d.quiz = repairLatex(d.quiz);
      for (const s of d.sections || []) {
        if (s.title) s.title = repairLatex(s.title).replace(/\$/g, ''); // 标题在界面是纯文本
        if (s.markdown) s.markdown = repairLatex(s.markdown);
        if (s.body) s.body = repairLatex(s.body);
      }
      for (const x of d.timeline || []) {
        if (x.title) x.title = repairLatex(x.title);
        if (x.text) x.text = repairLatex(x.text);
      }
      return JSON.stringify(d) !== before ? d : null;
    };
    for (const file of ['doc.json']) {
      const p = path.join(P.work, file);
      if (!fs.existsSync(p)) continue;
      const d = JSON.parse(fs.readFileSync(p, 'utf8'));
      const fixed = fixDoc(d);
      if (fixed) {
        fs.writeFileSync(p, JSON.stringify(fixed, null, 2), 'utf8');
        changed++;
      }
    }
    const sp = path.join(P.work, 'snapshots.json');
    if (fs.existsSync(sp)) {
      const arr = JSON.parse(fs.readFileSync(sp, 'utf8'));
      let hit = false;
      for (const s of arr) {
        if (!s.ocr) continue;
        const t = repairLatex(s.ocr.text || '');
        const ti = repairLatex(s.ocr.title || '');
        if (t !== s.ocr.text || ti !== s.ocr.title) hit = true;
        s.ocr.text = t;
        s.ocr.title = ti;
      }
      if (hit) {
        fs.writeFileSync(sp, JSON.stringify(arr, null, 2), 'utf8');
        changed++;
      }
    }
    totalFiles += changed;
    console.log(`  ${changed ? '已修正' : '无需修改'}  ${id}${changed ? `（${changed} 个文件）` : ''}`);
  }
  console.log(`\n共处理 ${list.length} 个项目，修正 ${totalFiles} 个文件。现在重新生成一次 PDF 即可看到效果（界面点「重新排版」）。`);
}

const cmds = { serve: cmdServe, run: cmdRun, doctor: cmdDoctor, fetch: cmdFetch, 'fix-latex': cmdFixLatex };
const fn = cmds[cmd];
if (!fn) {
  console.log('可用命令：serve | run | doctor | fetch | fix-latex');
  process.exit(1);
}
await fn();
