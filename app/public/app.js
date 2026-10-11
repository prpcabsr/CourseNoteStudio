/* 课程笔记工坊 · 前端逻辑 */
'use strict';

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const fmtTime = (t) => {
  t = Math.max(0, Math.floor(t || 0));
  const h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), s = t % 60;
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
};
const api = {
  async get(url) { const r = await fetch(url); if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || r.statusText); return r.json(); },
  async send(url, method, body) {
    const r = await fetch(url, { method, headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error || r.statusText);
    return j;
  },
  post(url, body) { return this.send(url, 'POST', body); },
  del(url) { return this.send(url, 'DELETE'); },
};

const state = {
  env: null, projects: [], current: null, snapshots: [], sections: [], logs: [],
  tab: 'board', stage: null, percent: 0, stageText: '等待开始', busy: false, es: null,
};

/* ─────────────── 主题 ─────────────── */
function initTheme() {
  const saved = localStorage.getItem('cns-theme');
  if (saved) document.documentElement.dataset.theme = saved;
  $('#btnTheme').onclick = () => {
    const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
    document.documentElement.dataset.theme = next;
    localStorage.setItem('cns-theme', next);
  };
}

/* ─────────────── 提示 ─────────────── */
function toast(msg, kind = '') {
  const el = document.createElement('div');
  el.className = 'toast ' + kind;
  el.textContent = msg;
  $('#toasts').appendChild(el);
  setTimeout(() => { el.style.opacity = '0'; el.style.transition = '.3s'; setTimeout(() => el.remove(), 320); }, kind === 'err' ? 8000 : 4200);
}

/* ─────────────── 环境状态 ─────────────── */
async function refreshEnv() {
  try {
    state.env = await api.get('/api/status');
  } catch (e) { return; }
  const e = state.env;
  const pills = [
    ['FFmpeg', e.ffmpeg], ['语音识别', e.asr.ready],
    ['视觉模型', e.vlm.some((v) => v.ready)], ['PDF', e.edge], ['文本模型', e.llm.ready],
  ];
  $('#envPills').innerHTML = pills.map(([n, ok]) =>
    `<span class="pill ${ok ? 'ok' : 'bad'}" data-need="${ok ? '' : n}" title="${ok ? n + ' 已就绪' : n + ' 尚未安装，点击打开安装面板'}"><span class="mark">${ok ? '✓' : '!'}</span>${n}</span>`).join('');
  $$('#envPills .pill.bad').forEach((p) => p.onclick = () => openDrawer());
  renderEnvSummary();
  renderResList();
  if (!e.coreInstalled) {
    const a = $('#homeAlert');
    a.className = 'alert warn';
    a.innerHTML = '首次使用需要先安装运行组件与模型（约 3.5 GB，可断点续传）。<a href="#" id="alertInstall">立即打开安装面板 →</a>';
    const btn = $('#alertInstall');
    if (btn) btn.onclick = (ev) => { ev.preventDefault(); openDrawer(); };
  } else {
    const a = $('#homeAlert');
    a.className = 'alert hidden';
    a.innerHTML = '';
  }
}

function renderEnvSummary() {
  const e = state.env; if (!e) return;
  const rows = [
    ['视频解码 FFmpeg', e.ffmpeg, e.ffmpeg ? '已就绪' : '缺少，无法抽帧与提取音频'],
    ['视频下载 yt-dlp', e.ytdlp, e.ytdlp ? '已就绪' : '缺少，无法下载网络视频'],
    ['语音识别', e.asr.ready, e.asr.ready ? '已就绪（SenseVoice）' : '缺少引擎或模型'],
    ['推理引擎 llama.cpp', e.llamaServer, e.llamaServer ? '已就绪' : '缺少，无法本地识别板书'],
    ['视觉模型', e.vlm.some((v) => v.ready), e.vlm.filter((v) => v.ready).map((v) => v.label).join('、') || '未安装'],
    ['PDF 引擎 Edge', e.edge, e.edge ? '已就绪' : '未找到 Microsoft Edge'],
    ['文本模型 Key', e.llm.ready, e.llm.ready ? `来源：${e.llm.source === 'dsh' ? '本机 DSH 保存的 DeepSeek Key' : e.llm.source}（${e.llm.keyMasked}）` : '未配置'],
  ];
  $('#envSummary').innerHTML = rows.map(([n, ok, h]) =>
    `<div class="env-line"><span class="${ok ? 'ok' : 'bad'}">${ok ? '✓' : '!'}</span><span class="n">${n}</span><span class="h">${h}</span></div>`).join('');
}

function renderResList(progress = {}) {
  const e = state.env; if (!e) return;
  const missing = e.resources.filter((r) => !r.installed && e.resources.some((x) => x.id === r.id));
  const coreMissing = ['ytdlp', 'ffmpeg', 'llamacpp-vulkan', 'sherpa', 'asr-sensevoice', 'asr-vad', 'asr-punct', 'vlm-qwen3vl-4b']
    .map((id) => e.resources.find((r) => r.id === id))
    .filter((r) => r && !r.installed);
  const hint = $('#installHint');
  if (hint) {
    hint.textContent = coreMissing.length
      ? `还缺 ${coreMissing.length} 个必需组件（合计约 ${(coreMissing.reduce((a, r) => a + r.size, 0) / 1073741824).toFixed(1)} GB），点下面的按钮安装，支持断点续传。`
      : '必需组件已全部就绪，无需下载。下面的按钮只在换电脑或误删文件后才需要用（未安装的都是可选备用项）。';
  }
  const core = $('#btnInstallCore');
  if (core) core.textContent = coreMissing.length ? '一键安装推荐组件' : '检查并修复缺失组件';
  $('#resList').innerHTML = e.resources.map((r) => {
    const p = progress[r.id];
    const pct = p ? p.percent : (r.installed ? 100 : (r.currentSize && r.size ? Math.min(99, Math.round(r.currentSize / r.size * 100)) : 0));
    const mb = (b) => (b / 1048576).toFixed(0) + ' MB';
    return `<div class="res-item" data-id="${r.id}">
      <div class="res-top"><span class="st ${r.installed ? 'ok' : 'no'}">${r.installed ? '已安装' : '未安装'}</span>
        <b>${r.label}</b><span class="sz">${r.installed ? '占用 ' + mb(r.currentSize) : '需下载 ' + mb(r.size)}</span></div>
      ${r.note ? `<div class="res-note">${r.note}</div>` : ''}
      ${p ? `<div class="res-bar"><i style="width:${pct}%"></i></div><div class="res-note">${p.file || ''} ${pct}%</div>` : ''}
    </div>`;
  }).join('');
}

/* ─────────────── 项目列表 ─────────────── */
async function refreshProjects() {
  try { state.projects = await api.get('/api/projects'); } catch { return; }
  const list = $('#projList');
  if (!state.projects.length) { list.innerHTML = '<div class="tiny" style="padding:8px 2px">还没有任务。</div>'; return; }
  list.innerHTML = state.projects.map((p) => {
    const st = p.stage === 'done' ? 'done' : (p.error ? 'failed' : (p.stages?.[p.stage]?.status === 'running' ? 'running' : ''));
    const label = p.stage === 'done' ? '已完成' : (p.error ? '出错' : (STAGE_LABEL[p.stage] || '待开始'));
    const raw = p.title || p.output?.docTitle || p.input || '未命名';
    // 本地文件只显示文件名，链接显示标题
    const name = /^[a-zA-Z]:\\|^\\\\|^\//.test(raw) ? raw.split(/[\\/]/).pop().replace(/\.[a-z0-9]{2,4}$/i, '') : raw;
    return `<div class="proj-item ${state.current?.id === p.id ? 'active' : ''}" data-id="${p.id}" title="${esc(raw)}">
      <div class="t">${esc(name)}</div>
      <div class="m"><span class="st ${st}">${label}</span>${p.hasPdf ? '<span>📄 PDF</span>' : ''}</div>
    </div>`;
  }).join('');
  $$('#projList .proj-item').forEach((el) => el.onclick = () => openProject(el.dataset.id));
}

const STAGE_LABEL = { created: '待开始', prepare: '获取视频', audio: '听懂课程', visual: '追踪板书', read: '识别板书', think: '组织笔记', render: '排版出稿', done: '已完成' };
/* 每个阶段在总进度条上占的区间 */
const STAGE_SPAN = { prepare: [0, 15], audio: [15, 30], visual: [30, 45], read: [45, 80], think: [80, 95], render: [95, 100] };
const spanOf = (stage) => STAGE_SPAN[stage] || [0, 100];
const within = (stage, percent) => {
  const [a, b] = spanOf(stage);
  return a + (b - a) * Math.max(0, Math.min(100, percent)) / 100;
};
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

/* ─────────────── 打开项目 ─────────────── */
async function openProject(id, { setHash = true } = {}) {
  const data = await api.get('/api/projects/' + id);
  const p = data;
  state.current = data;
  state.snapshots = data.snapshots || [];
  state.sections = [];
  state.logs = [];
  state.tab = 'board';
  switchView('project');
  if (setHash && location.hash !== `#/p/${id}`) location.hash = `#/p/${id}`;
  renderProjectHead();
  renderStages();
  renderBoard();
  $('#logs').textContent = '';
  // 从事件缓冲恢复日志与章节
  for (const ev of data.events || []) applyEvent(ev, true);
  if (data.doc?.sections) {
    data.doc.sections.forEach((s) => state.sections.push({ index: s.index, title: s.title, markdown: s.markdown, start: s.start, end: s.end }));
    renderNotes();
  }
  updatePreviewLinks();
  refreshProjects();
  await loadChatHistory();
  // 恢复进度显示（完成后不要还停在「等待开始」）
  if (p.error) setBar(state.percent, '已中断：' + p.error);
  else if (p.stage === 'done') setBar(100, '已完成');
  else if (p.stage && p.stage !== 'created') {
    const [a] = spanOf(p.stage);
    setBar(Math.max(state.percent, a), `${STAGE_LABEL[p.stage] || p.stage}${p.running ? ' 进行中…' : ''}`);
  } else setBar(0, '等待开始');
}

/** 支持 #/p/<id> 与 #/search 形式的地址，刷新后仍停留在原处。 */
function routeFromHash() {
  const m = location.hash.match(/^#\/p\/([A-Za-z0-9]+)/);
  if (m) openProject(m[1], { setHash: false }).catch(() => { switchView('home'); });
  else if (location.hash === '#/search') { switchView('search'); if (search.q && !$('#searchResults').children.length) runSearch(search.q); }
  else if (location.hash === '#/settings') { openDrawer().catch(() => {}); }
  else { state.current = null; closeDrawer(); switchView('home'); refreshProjects(); }
}

function goHome() {
  if (location.hash) location.hash = '';
  else { state.current = null; switchView('home'); refreshProjects(); }
}

function switchView(v) {
  $('#viewHome').classList.toggle('hidden', v !== 'home');
  $('#viewProject').classList.toggle('hidden', v !== 'project');
  $('#viewSearch').classList.toggle('hidden', v !== 'search');
}

/** 切换标签页（也支持用 ?tab=notes 之类的地址直接打开某一页） */
function activateTab(name) {
  const t = $$('#tabs .tab, #tabsSub .tab').find((x) => x.dataset.tab === name);
  if (t) t.click();
}

function renderProjectHead() {
  const p = state.current; if (!p) return;
  $('#pvTitle').textContent = p.title || p.output?.docTitle || '未命名任务';
  const bits = [p.input.length > 60 ? p.input.slice(0, 60) + '…' : p.input];
  const mi = p.mediaInfo;
  if (mi) bits.push(`${mi.width}×${mi.height}`, fmtTime(mi.duration));
  if (p.stats) bits.push(`板书 ${p.stats.snapshots} 屏`, `擦除前保存 ${p.stats.erased} 块`, `章节 ${p.stats.sections}`);
  $('#pvMeta').innerHTML = bits.map(esc).join(' <span style="opacity:.5">·</span> ');
  $('#btnRun').classList.toggle('hidden', p.stage === 'done' && !p.error);
  $('#btnCancel').classList.toggle('hidden', !p.running);
  $('#btnRun').disabled = !!p.running;
}

function renderStages() {
  const p = state.current; const stages = state.env?.stages || [];
  $('#steps').innerHTML = stages.map((s, i) => {
    const st = p?.stages?.[s.id]?.status || (p?.stage === s.id ? 'running' : '');
    return `<div class="step-chip ${st}"><span class="n">${st === 'done' ? '✓' : i + 1}</span>
      <span><span class="l">${s.label}</span><br><span class="d">${s.desc}</span></span></div>`;
  }).join('');
}

function setBar(percent, text) {
  state.percent = percent; state.stageText = text;
  $('#barIn').style.width = Math.max(0, Math.min(100, percent)) + '%';
  $('#barLabel').textContent = text;
}

/* ─────────────── 板书流 ─────────────── */
function renderBoard() {
  const grid = $('#boardGrid');
  $('#badgeBoard').textContent = state.snapshots.length;
  if (!state.snapshots.length) { $('#boardEmpty').classList.remove('hidden'); grid.innerHTML = ''; return; }
  $('#boardEmpty').classList.add('hidden');
  grid.innerHTML = state.snapshots.map((s, i) => {
    const txt = (s.text || '').trim();
    return `<div class="board-card">
      <div class="bc-head">
        <span class="bc-gen">第 ${(s.generation ?? 0) + 1} 块</span>
        <span class="bc-time">${fmtTime(s.t)}</span>
        ${s.erased ? '<span class="tag erase">擦除前抢救</span>' : '<span class="tag keep">板书</span>'}
        <span class="tag gen">${esc(s.scene || '')}</span>
      </div>
      ${s.image ? `<img src="${s.image}" loading="lazy" data-full="${s.image}" alt="板书 ${fmtTime(s.t)}">` : ''}
      <div class="bc-body ${txt ? '' : 'empty-text'}">${txt ? esc(txt) : '（这一屏没有识别到文字）'}</div>
    </div>`;
  }).join('');
  $$('#boardGrid img').forEach((im) => im.onclick = () => showLightbox(im.dataset.full));
  attachImageAsk($('#boardGrid'));
  renderMath($('#boardGrid'));
}

/** 用 KaTeX 渲染板书文字里的公式（离线，随应用一起分发）。 */
function renderMath(el) {
  if (!el || typeof renderMathInElement !== 'function') return;
  try {
    renderMathInElement(el, {
      delimiters: [
        { left: '$$', right: '$$', display: true },
        { left: '$', right: '$', display: false },
      ],
      throwOnError: false,
      ignoredTags: ['script', 'noscript', 'style', 'textarea', 'pre', 'code'],
    });
  } catch {}
}

/* ─────────────── 布局：三栏宽度可拖拽，记忆在本地 ─────────────── */
function setupResizers() {
  const saved = {
    side: Number(localStorage.getItem('cns-w-side')) || 268,
    ai: Number(localStorage.getItem('cns-w-ai')) || 400,
  };
  document.documentElement.style.setProperty('--sidebar-w', saved.side + 'px');
  document.documentElement.style.setProperty('--ai-w', saved.ai + 'px');

  const bind = (handle, key, min, max, getWidth, setWidth, invert) => {
    if (!handle) return;
    let startX = 0;
    let startW = 0;
    const onMove = (e) => {
      const dx = (e.clientX ?? e.touches?.[0]?.clientX ?? 0) - startX;
      const w = Math.max(min, Math.min(max, startW + (invert ? -dx : dx)));
      setWidth(w);
    };
    const onUp = () => {
      handle.classList.remove('dragging');
      document.removeEventListener('pointermove', onMove);
      document.removeEventListener('pointerup', onUp);
      document.body.style.userSelect = '';
      localStorage.setItem(key, String(Math.round(getWidth())));
    };
    handle.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      startX = e.clientX;
      startW = getWidth();
      handle.classList.add('dragging');
      document.body.style.userSelect = 'none';
      document.addEventListener('pointermove', onMove);
      document.addEventListener('pointerup', onUp);
    });
    handle.addEventListener('dblclick', () => {
      // 双击复位
      const def = key === 'cns-w-side' ? 268 : 400;
      setWidth(def);
      localStorage.setItem(key, String(def));
    });
  };

  bind(
    $('#rsSide'),
    'cns-w-side',
    180,
    460,
    () => $('#sidebar').getBoundingClientRect().width,
    (w) => document.documentElement.style.setProperty('--sidebar-w', w + 'px'),
    false,
  );
  bind(
    $('#rsAi'),
    'cns-w-ai',
    300,
    Math.max(360, window.innerWidth - 720),
    () => $('#aiDock').getBoundingClientRect().width,
    (w) => document.documentElement.style.setProperty('--ai-w', w + 'px'),
    true,
  );
}

/* ─────────────── AI 问答面板 ─────────────── */
const ai = {
  chips: [], // {type:'text'|'image', label, content|file, url}
  busy: false,
};

/** 面板常驻右侧；只有用户主动收起时才隐藏，并留一条窄边可以再展开 */
function aiToggle(open) {
  const next = open ?? $('#aiDock').classList.contains('collapsed');
  $('#aiDock').classList.toggle('collapsed', !next);
  $('#rsAi').classList.toggle('hidden', !next);
  $('#aiRail').classList.toggle('hidden', next);
  localStorage.setItem('cns-ai-open', next ? '1' : '0');
  if (next) setTimeout(() => $('#aiInput').focus(), 50);
}

function renderChips() {
  $('#aiChips').innerHTML = ai.chips
    .map((c, i) => {
      if (c.type === 'image') return `<span class="ai-chip"><img src="${c.url}"><span class="t">板书图片</span><button data-i="${i}" title="移除">✕</button></span>`;
      return `<span class="ai-chip"><span class="t" title="${esc(c.content)}">“${esc(c.content.slice(0, 40))}${c.content.length > 40 ? '…' : ''}”</span><button data-i="${i}" title="移除">✕</button></span>`;
    })
    .join('');
  $$('#aiChips button').forEach((b) => (b.onclick = () => {
    ai.chips.splice(Number(b.dataset.i), 1);
    renderChips();
  }));
  const hasImg = ai.chips.some((c) => c.type === 'image');
  $('#aiRoute').textContent = hasImg ? '这次会交给视觉模型（图片）' : '选中的文字会交给文本模型';
}

function aiAddText(content, section) {
  const text = String(content || '').trim();
  if (!text) return;
  if (ai.chips.some((c) => c.type === 'text' && c.content === text)) return;
  ai.chips.push({ type: 'text', content: text, section: section || null });
  renderChips();
  aiToggle(true);
}

function aiAddImage(file, url) {
  if (ai.chips.some((c) => c.type === 'image' && c.file === file)) return;
  ai.chips.push({ type: 'image', file, url });
  renderChips();
  aiToggle(true);
}

function aiPushMsg(kind, html, meta = {}) {
  const el = document.createElement('div');
  el.className = 'ai-msg ' + kind;
  const who = meta.who ? `<div class="who">${esc(meta.who)}</div>` : '';
  const quote = meta.quote ? `<div class="quote">${esc(meta.quote.slice(0, 300))}${meta.quote.length > 300 ? '…' : ''}</div>` : '';
  const thumbs = meta.images?.length ? `<div class="thumbs">${meta.images.map((u) => `<img src="${u}">`).join('')}</div>` : '';
  el.innerHTML = who + quote + thumbs + `<div class="ai-body">${html}</div>`;
  $('#aiEmpty')?.classList.add('hidden');
  $('#aiThread').appendChild(el);
  renderMath(el);
  $('#aiThread').scrollTop = $('#aiThread').scrollHeight;
  return el;
}

function mdSafe(s) {
  // AI 回答：保留换行，转义 HTML，公式交给 KaTeX
  return esc(s).replace(/\n/g, '<br>');
}

/** 载入这个任务之前的 AI 对话 */
async function loadChatHistory() {
  const box = $('#aiThread');
  box.innerHTML = '<div class="ai-empty" id="aiEmpty">还没有对话。<br>选一段笔记内容，再问它「这是什么意思」「帮我推导一下」。</div>';
  try {
    const log = await api.get(`/api/projects/${state.current.id}/chat`);
    for (const item of log || []) {
      aiPushMsg('user', mdSafe(item.question || '（针对所选内容提问）'), {
        quote: item.selection || '',
        images: (item.images || []).map((f) => `/api/projects/${state.current.id}/figures/${f}`),
        who: '我',
      });
      aiPushMsg('bot', mdSafe(item.answer || ''), { who: item.engine || 'AI' });
    }
  } catch {}
}

/* ─────────────── 全局搜索 ─────────────── */
const search = { q: '', mode: 'exact', busy: false };

function searchSetMode(mode) {
  search.mode = mode;
  $$('.side-search .seg').forEach((b) => b.classList.toggle('active', b.dataset.mode === mode));
  $$('#viewSearch .seg').forEach((b) => b.classList.toggle('active', b.dataset.smode === mode));
}

async function runSearch(q, mode) {
  q = (q ?? $('#searchInput').value).trim();
  if (!q) return;
  search.q = q;
  searchSetMode(mode || search.mode);
  location.hash = '#/search';
  $('#searchQuery').textContent = q;
  $('#searchMeta').textContent = search.mode === 'ai' ? 'AI 模糊搜索中…' : '查找中…';
  $('#searchAnswer').classList.add('hidden');
  $('#searchResults').innerHTML = '<div class="search-empty">正在搜索…</div>';
  if (search.busy) return;
  search.busy = true;
  try {
    const r = await api.get(`/api/search?mode=${search.mode}&q=${encodeURIComponent(q)}`);
    renderSearchResults(r);
  } catch (e) {
    $('#searchMeta').textContent = '';
    $('#searchResults').innerHTML = `<div class="search-empty">搜索失败：${esc(e.message)}</div>`;
  } finally {
    search.busy = false;
  }
}

/**
 * 搜索片段：先把 $...$ 公式挖出来保护住，只对普通文字做高亮，
 * 再把公式原样放回去交给 KaTeX 排版（免得 <mark> 插进公式里把它弄坏）。
 */
function highlightSnippet(text, q) {
  const store = [];
  let masked = String(text).replace(/\$\$[\s\S]*?\$\$|\$[^$\n]*\$/g, (m) => {
    store.push(m);
    return `\u0000${store.length - 1}\u0000`;
  });
  // 截断可能把公式切断，剩下的孤立 $ 直接去掉更清爽
  masked = masked.replace(/\$/g, '');
  let html = esc(masked);
  for (const t of q.split(/\s+/).filter(Boolean)) {
    const re = new RegExp('(' + t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + ')', 'gi');
    html = html.replace(re, '<mark>$1</mark>');
  }
  return html.replace(/\u0000(\d+)\u0000/g, (_, i) => esc(store[Number(i)] ?? ''));
}

const KIND_LABEL = {
  transcript: '讲稿原话',
  board: '板书',
  section: '笔记正文',
  overview: '概览',
  objective: '学习目标',
  formulas: '公式',
  glossary: '术语表',
  quiz: '自测题',
};

function renderSearchResults(r) {
  const hits = r.hits || [];
  if (r.mode === 'ai') {
    $('#searchMeta').textContent = hits.length
      ? `AI 判断出 ${hits.length} 处相关（从 ${r.candidates} 个候选里挑出）`
      : 'AI 没有找到相关内容';
  } else {
    $('#searchMeta').textContent = hits.length ? `找到 ${r.total} 处（显示前 ${hits.length} 处）` : '没有找到';
  }
  if (r.answer) {
    const box = $('#searchAnswer');
    box.classList.remove('hidden');
    box.innerHTML = `<div class="who">🤖 AI 直接回答</div>${mdSafe(r.answer)}`;
    renderMath(box);
  } else {
    $('#searchAnswer').classList.add('hidden');
  }
  if (!hits.length) {
    $('#searchResults').innerHTML = `<div class="search-empty">
      没有找到「${esc(search.q)}」<br>
      ${search.mode === 'ai' ? '换个说法再试试，或者切回「原话」按字面找。' : '试试切到「AI 模糊」，用大概的意思来找。'}
    </div>`;
    return;
  }
  $('#searchResults').innerHTML = hits
    .map((h, i) => {
      const kind = KIND_LABEL[h.kind] || h.kind;
      const label = h.label && h.label !== kind && !h.label.startsWith(kind) ? `<span class="tiny">${esc(h.label)}</span>` : '';
      return `<div class="sr-card" data-i="${i}">
        <div class="sr-head">
          <span class="p">${esc(h.ptitle)}</span>
          <span class="tag time">${esc(kind)}</span>
          ${h.time ? `<span class="tag">${esc(h.time)}</span>` : ''}
          ${label}
        </div>
        <div class="sr-body">${highlightSnippet(h.snippet, search.q)}</div>
        ${h.why ? `<div class="sr-why">为什么相关：${esc(h.why)}</div>` : ''}
      </div>`;
    })
    .join('');
  renderMath($('#searchResults'));
  $$('#searchResults .sr-card').forEach((card) => {
    card.onclick = () => openSearchHit(hits[Number(card.dataset.i)]);
  });
}

/** 点搜索结果 → 打开对应任务，并跳到对应的章节/板书 */
async function openSearchHit(hit) {
  await openProject(hit.pid);
  if (hit.kind === 'section' && hit.t != null) {
    const secs = state.sections || [];
    let idx = -1;
    for (let i = 0; i < secs.length; i++) if (secs[i].start <= hit.t + 1) idx = i;
    if (idx >= 0) {
      activateTab('notes');
      const el = $$('#noteList .note-card')[idx + 1]; // 第 0 张是概览
      if (el) {
        el.scrollIntoView({ behavior: 'smooth', block: 'start' });
        el.classList.add('flash');
        setTimeout(() => el.classList.remove('flash'), 2200);
      }
      return;
    }
  }
  if (hit.kind === 'board') {
    activateTab('board');
    const cards = $$('#boardGrid .board-card');
    const el = cards[Math.min(cards.length - 1, Math.max(0, cards.findIndex((c) => c.textContent.includes(hit.time))))];
    if (el) {
      el.scrollIntoView({ behavior: 'smooth', block: 'center' });
      el.classList.add('flash');
      setTimeout(() => el.classList.remove('flash'), 2200);
    }
    return;
  }
  activateTab('notes');
  $('#noteList')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

/* ─────────────── AI 补充（成稿预览里的旁注 + 补充讲解页） ─────────────── */
const supp = { items: [], on: true, busy: false };

async function loadSupplements() {
  if (!state.current) return;
  try {
    const r = await api.get(`/api/projects/${state.current.id}/supplements`);
    supp.items = r.items || [];
  } catch {
    supp.items = [];
  }
  renderSupplements();
  if (supp.items.length) setTimeout(drawMarginNotes, 200); // iframe 可能已经加载完了
}

function renderSupplements() {
  const n = supp.items.length;
  $('#tabsSub').classList.toggle('hidden', n === 0);
  $('#badgeSupp').textContent = n;
  $('#linkSupp').classList.toggle('hidden', n === 0);
  $('#suppToggleWrap').classList.toggle('hidden', n === 0);
  $('#suppEmpty').classList.toggle('hidden', n > 0);
  $('#suppMeta').textContent = n ? `共 ${n} 条 · 按章节顺序排列` : '';
  $('#suppList').innerHTML = supp.items
    .map(
      (it) => `<div class="supp-item">
        <h4>${esc(it.title || '补充')}<span class="where">第 ${it.section} 节</span></h4>
        <div class="short">${esc(it.short || '')}</div>
        ${it.more ? `<div class="more">${mdSafe(it.more)}</div>` : ''}
        ${it.anchor ? `<div class="anchor">原文片段：${esc(it.anchor)}</div>` : ''}
      </div>`,
    )
    .join('');
  renderMath($('#suppList'));
}

async function runSupplements(force = false) {
  if (!state.current || supp.busy) return;
  if (!force && supp.items.length) return;
  supp.busy = true;
  const btn = $('#btnSupp');
  const old = btn.textContent;
  btn.disabled = true;
  btn.textContent = '✨ 正在分析课程…';
  $('#suppHint').textContent = 'AI 正在通读全部章节，找出课程里没讲但很关键的知识点（约 10–30 秒）…';
  try {
    const r = await api.post(`/api/projects/${state.current.id}/supplements`, {});
    supp.items = r.items || [];
    renderSupplements();
    $('#suppHint').textContent = supp.items.length
      ? `已补充 ${supp.items.length} 条，看右侧空白处的批注；想看详细解释点「在一页里看全部」。`
      : 'AI 认为这份笔记已经比较完整，没有需要额外补充的关键点。';
    if (supp.items.length) {
      drawMarginNotes();
      toast(`已补充 ${supp.items.length} 条`, 'ok');
    }
  } catch (e) {
    $('#suppHint').textContent = '失败：' + e.message;
  } finally {
    supp.busy = false;
    btn.disabled = false;
    btn.textContent = old === '✨ 正在分析课程…' ? '✨ AI 补充' : old;
  }
}

/** 把旁注画进成稿预览（iframe 内同源，可以直接操作它的 DOM）。 */
function drawMarginNotes() {
  try {
    return drawMarginNotesInner();
  } catch (e) {
    $('#suppHint').textContent = '批注绘制失败：' + e.message;
    return 0;
  }
}

function drawMarginNotesInner() {
  const frame = $('#previewFrame');
  if (!frame || frame.classList.contains('hidden') || !supp.items.length) return 0;
  let doc;
  try {
    doc = frame.contentDocument;
  } catch {
    return 0;
  }
  if (!doc || !doc.body) return 0;
  const win = frame.contentWindow;
  const old = doc.getElementById('aiSuppLayer');
  if (old) old.remove();

  const layer = doc.createElement('div');
  layer.id = 'aiSuppLayer';
  layer.innerHTML = `
    <style>
      #aiSuppLayer { position: absolute; top: 0; left: 0; width: 0; height: 0; z-index: 60; }
      #aiSuppLayer .note {
        position: absolute; width: 232px; padding: 9px 11px; box-sizing: border-box;
        background: #fffdf5; border: 1px solid #e8d9a8; border-left: 3px solid #e0a800; border-radius: 8px;
        box-shadow: 0 4px 14px -8px rgba(120,90,0,.55); font-size: 12.5px; line-height: 1.75;
        transform: rotate(-.5deg); pointer-events: auto; color: #4a3a12;
      }
      #aiSuppLayer .note.dark { background: #2a2415; border-color: #6b5a20; color: #f0e3bb; }
      #aiSuppLayer .note h5 {
        font-family: var(--hand, cursive); font-size: 16px; font-weight: 400; margin-bottom: 3px;
        color: #a06a00; letter-spacing: .5px;
      }
      #aiSuppLayer .note.dark h5 { color: #ffd166; }
      #aiSuppLayer .note .t { font-family: var(--hand, cursive); font-size: 16.5px; line-height: 1.85; }
      #aiSuppLayer .note a {
        display: inline-block; margin-top: 5px; font-size: 11.5px; color: #b45309; text-decoration: none;
        border-bottom: 1px dashed currentColor; cursor: pointer;
      }
      #aiSuppLayer .note a:hover { color: #ea580c; }
      #aiSuppLayer svg { position: absolute; top: 0; left: 0; overflow: visible; pointer-events: none; }
      body.ai-supp-on { padding-right: 288px; }
    </style>`;
  doc.body.appendChild(layer);
  doc.body.classList.toggle('ai-supp-on', supp.on);
  if (!supp.on) return 0;
  const handStack = getComputedStyle(document.documentElement).getPropertyValue('--hand').trim();

  const scrollW = Math.max(doc.documentElement.scrollWidth, doc.body.scrollWidth);
  const svg = doc.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('width', scrollW);
  svg.setAttribute('height', 100);
  svg.innerHTML = `<defs><marker id="aiArrowHead" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto">
      <path d="M0,0 L7,3 L0,6 z" fill="#d97706"/></marker></defs>`;
  layer.appendChild(svg);

  const isDark = document.documentElement.dataset.theme === 'dark';
  let made = 0;
  const placed = []; // 已经放下的批注，用来避免互相压住
  for (const it of supp.items) {
    const target = findAnchorElement(doc, it);
    if (!target) continue;
    const r = target.getBoundingClientRect();
    let top = r.top + win.scrollY + Math.min(18, Math.max(0, r.height / 2 - 10));
    const left = r.right + win.scrollX + 34;

    const note = doc.createElement('div');
    note.className = 'note' + (isDark ? ' dark' : '');
    note.style.left = left + 'px';
    note.style.top = top + 'px';
    note.style.setProperty('--hand', handStack);
    note.innerHTML = `<h5>${esc(it.title || '补充')}</h5><div class="t">${esc(it.short || '')}</div>
      <a data-supp="${made}">了解更多 →</a>`;
    note.querySelector('a').onclick = (ev) => {
      ev.preventDefault();
      activateTab('supp');
      const card = $$('#suppList .supp-item')[supp.items.indexOf(it)];
      if (card) {
        card.scrollIntoView({ behavior: 'smooth', block: 'center' });
        card.classList.add('flash');
        setTimeout(() => card.classList.remove('flash'), 2200);
      }
    };
    layer.appendChild(note); // 先放进去才能量到真实高度

    // 用实际高度往下挪，直到不和已放置的批注重叠
    let h = note.offsetHeight || 96;
    for (let guard = 0; guard < 30; guard++) {
      const clash = placed.find((p) => Math.abs(p.left - left) < 260 && top < p.top + p.h + 8 && top + h > p.top);
      if (!clash) break;
      top = clash.top + clash.h + 12;
      note.style.top = top + 'px';
      h = note.offsetHeight || h;
    }
    placed.push({ left, top, h });

    // 箭头：从批注指向原文
    const fromX = left - 6;
    const fromY = top + 16;
    const toX = r.right + win.scrollX + 6;
    const toY = r.top + win.scrollY + Math.min(r.height / 2, 16);
    const midX = (fromX + toX) / 2;
    const p = doc.createElementNS('http://www.w3.org/2000/svg', 'path');
    p.setAttribute('d', `M ${fromX} ${fromY} C ${midX} ${fromY}, ${midX} ${toY}, ${toX} ${toY}`);
    p.setAttribute('fill', 'none');
    p.setAttribute('stroke', '#d97706');
    p.setAttribute('stroke-width', '1.5');
    p.setAttribute('stroke-dasharray', '5 3');
    p.setAttribute('marker-end', 'url(#aiArrowHead)');
    p.setAttribute('opacity', '.85');
    svg.appendChild(p);
    made++;
  }
  svg.setAttribute('height', Math.max(doc.body.scrollHeight, 100));
  $('#suppHint').textContent = made
    ? `已在右侧空白处标出 ${made} 处补充（虚线箭头指向对应段落，想看详细解释点「在一页里看全部」）`
    : `生成了 ${supp.items.length} 条补充，但没能在成稿里找到对应段落，请到「补充讲解」页查看`;
  return made;
}

/**
 * 在成稿里找到 anchor 所在的段落元素。
 * 注意：成稿里的公式已经被 KaTeX 渲染成 DOM，$f(x)$ 在页面上不是这几个字符了，
 * 所以两边都去掉公式，只拿「普通文字」比对。
 */
function suppPlain(el) {
  const clone = el.cloneNode(true);
  clone.querySelectorAll('.katex, .katex-display, math, annotation').forEach((n) => n.remove());
  return clone.textContent.replace(/\s+/g, '');
}
function suppKey(anchor) {
  return String(anchor || '')
    .replace(/\$\$[^$]*\$\$|\$[^$]*\$/g, '')
    .replace(/\\[a-zA-Z]+/g, '')
    .replace(/\s+/g, '');
}

function findAnchorElement(doc, item) {
  // 只认正文的 <section class="section">——目录、封面、附录也是 <section>，不能算进来
  const secs = [...doc.querySelectorAll('section.section')];
  let scope = secs[item.section - 1];
  // 优先按章节标题定位（笔记重新生成后节号可能变，标题更稳）
  if (item.sectionTitle) {
    const t = String(item.sectionTitle).replace(/\s+/g, '');
    const byTitle = secs.find((s) => (s.querySelector('h2')?.textContent || '').replace(/\s+/g, '').includes(t));
    if (byTitle) scope = byTitle;
  }
  if (!scope) scope = doc.body;
  const cands = [...scope.querySelectorAll('p, li, h3, h4, td, blockquote')].filter((el) => el.textContent.trim().length > 8);

  const key = suppKey(item.anchor);
  if (key.length >= 3) {
    let best = null;
    for (const el of cands) {
      if (suppPlain(el).includes(key)) {
        if (!best || el.textContent.length < best.textContent.length) best = el; // 取最小的那个
      }
    }
    if (best) return best;
  }
  // 锚点几乎全是公式时的兜底：拿原始 anchor（去掉 $）直接比对
  const raw = String(item.anchor || '').replace(/\$/g, '').replace(/\s+/g, '');
  if (raw.length >= 4) {
    for (const el of cands) {
      if (el.textContent.replace(/\s+/g, '').includes(raw)) return el;
    }
  }
  // 再兜底：该节第一个有内容的段落
  return cands.find((el) => el.tagName === 'P' && el.textContent.trim().length > 20) || cands[0] || null;
}

async function aiSend() {
  if (ai.busy) return;
  const input = $('#aiInput');
  const question = input.value.trim();
  if (!question && !ai.chips.length) { toast('先选一段笔记，或输入你的问题', 'warn'); return; }
  const chips = [...ai.chips];
  const sel = chips.filter((c) => c.type === 'text');
  const imgs = chips.filter((c) => c.type === 'image');
  const selection = sel.map((c) => c.content).join('\n---\n');
  const section = sel.find((c) => c.section)?.section || null;

  aiPushMsg('user', mdSafe(question || '（针对所选内容提问）'), {
    quote: selection,
    images: imgs.map((c) => c.url),
    who: '我',
  });
  input.value = '';
  ai.chips = [];
  renderChips();

  ai.busy = true;
  const btn = $('#btnAiSend');
  btn.disabled = true;
  const pending = aiPushMsg('bot', '<span class="tiny">思考中…（带图片时用本地视觉模型，通常 5–20 秒）</span>', {
    who: imgs.length ? '视觉模型' : '文本模型',
  });
  try {
    const r = await api.post(`/api/projects/${state.current.id}/chat`, {
      question,
      selection,
      section,
      images: imgs.map((c) => c.file),
    });
    pending.querySelector('.ai-body').innerHTML = mdSafe(r.answer);
    renderMath(pending);
    pending.querySelector('.who').textContent = r.engine || 'AI';
    $('#aiEngine').textContent = r.engine || '';
  } catch (e) {
    pending.classList.add('err');
    pending.querySelector('.ai-body').innerHTML = '回答失败：' + esc(e.message);
  } finally {
    ai.busy = false;
    btn.disabled = false;
    $('#aiThread').scrollTop = $('#aiThread').scrollHeight;
  }
}

/** 从一段选区里取出正文 + 所属章节，作为提问的背景 */
function contextFromSelection(sel, doc) {
  if (!sel || sel.rangeCount === 0) return null;
  const text = sel.toString().trim();
  if (!text) return null;
  const node = sel.getRangeAt(0).commonAncestorContainer;
  const el = node.nodeType === 1 ? node : node.parentElement;
  if (!el) return null;
  // 笔记章节页（我们自己的 DOM）
  const card = el.closest('.note-card');
  if (card) {
    const title = card.querySelector('h3')?.textContent?.replace(/^\d+\s*/, '').trim() || '';
    const body = card.querySelector('.note-body')?.innerText || '';
    return { text, host: el, section: title ? { title, text: body.slice(0, 3000) } : null };
  }
  // 成稿预览（iframe 里的 notes.html）
  const sectionEl = el.closest('.section');
  if (sectionEl) {
    const title = sectionEl.querySelector('h2')?.innerText?.replace(/\s+/g, ' ').trim() || '';
    return { text, host: el, section: title ? { title, text: (sectionEl.innerText || '').slice(0, 3000) } : null };
  }
  // 板书卡片
  if (el.closest('.board-card')) return { text, host: el, section: null };
  return null;
}

/** 划选文字后浮出「问 AI」按钮 */
function setupSelectionAsk() {
  const btn = document.createElement('button');
  btn.className = 'ask-float hidden';
  btn.textContent = '🤖 问 AI';
  document.body.appendChild(btn);
  let current = null;
  const hide = () => { btn.classList.add('hidden'); current = null; };

  document.addEventListener('mouseup', (e) => {
    if (e.target === btn) return;
    setTimeout(() => {
      const info = contextFromSelection(window.getSelection(), document);
      if (!info) return hide();
      current = info;
      const rect = window.getSelection().getRangeAt(0).getBoundingClientRect();
      btn.style.left = `${Math.max(8, Math.min(window.innerWidth - 110, rect.left + rect.width / 2 - 45)) + window.scrollX}px`;
      btn.style.top = `${rect.top + window.scrollY - 38}px`;
      btn.classList.remove('hidden');
    }, 0);
  });
  document.addEventListener('mousedown', (e) => { if (e.target !== btn) hide(); });
  document.addEventListener('scroll', hide, true);
  btn.addEventListener('mousedown', (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (current) aiAddText(current.text, current.section);
    hide();
  });
}

/** 右键菜单：选中文字后右键 → 询问 AI（不用先复制） */
function setupContextMenu() {
  const menu = document.createElement('div');
  menu.className = 'ctx-menu hidden';
  document.body.appendChild(menu);

  const close = () => menu.classList.add('hidden');

  const openMenu = (x, y, info, doc) => {
    menu.innerHTML = `
      <button data-act="ask">🤖 询问 AI<span class="k">放进输入框</span></button>
      <button data-act="explain">💡 直接解释这段</button>
      <div class="sep"></div>
      <button data-act="copy">📋 复制<span class="k">Ctrl+C</span></button>`;
    menu.classList.remove('hidden');
    const w = menu.offsetWidth;
    const h = menu.offsetHeight;
    menu.style.left = `${Math.min(x, window.innerWidth - w - 8) + window.scrollX}px`;
    menu.style.top = `${Math.min(y, window.innerHeight - h - 8) + window.scrollY}px`;
    menu.querySelectorAll('button').forEach((b) => {
      b.onclick = async () => {
        close();
        if (b.dataset.act === 'copy') {
          try { await navigator.clipboard.writeText(info.text); toast('已复制选中内容', 'ok'); } catch { toast('复制失败', 'err'); }
          return;
        }
        aiAddText(info.text, info.section);
        if (b.dataset.act === 'explain') {
          $('#aiInput').value = '请解释这段内容：它在讲什么？关键概念是什么？';
          aiSend();
        }
      };
    });
  };

  document.addEventListener('contextmenu', (e) => {
    const info = contextFromSelection(window.getSelection(), document);
    if (!info || !info.host || !info.host.contains(e.target)) return; // 没选中就保留系统菜单
    e.preventDefault();
    openMenu(e.clientX, e.clientY, info, document);
  });
  document.addEventListener('click', close);
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') close(); });
  window.addEventListener('blur', close);
  // 便于截图核对菜单样式（?ctxdemo=1 时在页面中间弹一次）
  window.__ctxDemo = () => openMenu(window.innerWidth / 2 - 90, 320, { text: '示例：选中的笔记文字会被放进输入框', section: null }, document);

  // 成稿预览的 iframe 是同源的，也把右键接上
  const frame = $('#previewFrame');
  frame.addEventListener('load', () => {
    try {
      const d = frame.contentDocument;
      if (!d) return;
      d.addEventListener('contextmenu', (e) => {
        const info = contextFromSelection(frame.contentWindow.getSelection(), d);
        if (!info || !info.host || !info.host.contains(e.target)) return;
        e.preventDefault();
        const r = frame.getBoundingClientRect();
        openMenu(r.left + e.clientX, r.top + e.clientY, info, d);
      });
      d.addEventListener('click', close);
    } catch {}
  });
}

/** 给笔记/板书里的图片挂上「问 AI」 */
function attachImageAsk(root) {
  $$('img[data-full]', root).forEach((img) => {
    if (img.dataset.askBound) return;
    img.dataset.askBound = '1';
    const wrap = document.createElement('span');
    wrap.className = 'img-wrap';
    img.parentNode.insertBefore(wrap, img);
    wrap.appendChild(img);
    const b = document.createElement('button');
    b.className = 'img-ask';
    b.textContent = '🤖 问 AI';
    b.title = '把这张图发给 AI 提问';
    b.onclick = (ev) => {
      ev.stopPropagation();
      const file = String(img.dataset.full || img.src || '').split('/').pop();
      aiAddImage(file, img.dataset.full || img.src);
    };
    wrap.appendChild(b);
  });
}

function showLightbox(src) {
  const d = document.createElement('div');
  d.className = 'lightbox';
  d.innerHTML = `<img src="${src}"><button class="lb-ask">🤖 拿这张问 AI</button>`;
  d.onclick = (e) => { if (e.target === d) d.remove(); };
  d.querySelector('.lb-ask').onclick = (e) => {
    e.stopPropagation();
    aiAddImage(String(src).split('/').pop(), src);
    d.remove();
  };
  document.body.appendChild(d);
}

/* ─────────────── 章节 ─────────────── */
/** 笔记正文用「和 PDF 完全相同」的服务端渲染结果，保证界面与成稿一致。 */
async function renderNotes() {
  const p = state.current;
  if (!p) return;
  try {
    const data = await api.get(`/api/projects/${p.id}/sections`);
    state.notesDoc = data;
    const list = $('#noteList');
    const sections = (data && data.sections) || [];
    $('#badgeNotes').textContent = sections.length;
    if (!sections.length) {
      $('#notesEmpty').classList.remove('hidden');
      list.innerHTML = '';
      return;
    }
    $('#notesEmpty').classList.add('hidden');
    const head = [];
    if (data.overview) head.push(`<div class="note-card"><h3>本讲概览</h3><div class="note-body">${data.overview}</div></div>`);
    if (data.objectives?.length) head.push(`<div class="note-card"><h3>学习目标</h3><div class="note-body"><ul>${data.objectives.map((o) => `<li>${o}</li>`).join('')}</ul></div></div>`);
    const body = sections.map((s) => `
      <div class="note-card">
        <h3><span class="n">${String((s.index ?? 0) + 1).padStart(2, '0')}</span>${esc(s.title)}</h3>
        <div class="tiny" style="margin-top:2px">${fmtTime(s.start)} – ${fmtTime(s.end)}</div>
        <div class="note-body">${s.html}</div>
        ${(s.images || []).length ? `<div class="note-figs">${s.images.map((u) => `<img src="${u}" loading="lazy" data-full="${u}">`).join('')}</div>` : ''}
      </div>`).join('');
    const tail = [];
    if (data.formulas) tail.push(`<div class="note-card"><h3>关键公式与定理</h3><div class="note-body">${data.formulas}</div></div>`);
    if (data.glossary) tail.push(`<div class="note-card"><h3>术语表</h3><div class="note-body">${data.glossary}</div></div>`);
    if (data.quiz) tail.push(`<div class="note-card"><h3>复习自测</h3><div class="note-body">${data.quiz}</div></div>`);
    // 板书全时间线（原先在 PDF 附录里，现在只在界面看）
    const board = data.board || [];
    if (board.length) {
      const groups = new Map();
      for (const b of board) {
        const arr = groups.get(b.generation) || [];
        arr.push(b);
        groups.set(b.generation, arr);
      }
      let html = `<div class="note-card"><h3>附录 · 板书全时间线 <span class="tiny" style="font-weight:400">（共 ${groups.size} 块板书）</span></h3>
        <div class="tiny" style="margin:2px 0 8px">按时间顺序列出每一块板书。标记「之后被擦除」的，是程序在老师擦掉它之前抓取保存的完整内容——黑板上已经看不到的，这里还留着。</div><div class="board-timeline">`;
      for (const [gen, items] of [...groups.entries()].sort((a, b) => a[0] - b[0])) {
        const first = items[0];
        const last = items[items.length - 1];
        const erased = items.some((i) => i.erased);
        html += `<div class="bt-group">
          <div class="bt-head"><b>第 ${gen + 1} 块板书</b><span class="tag time">${fmtTime(first.t)} – ${fmtTime(last.t)}</span>
            ${erased ? '<span class="tag erase">之后被擦除，内容已保存</span>' : '<span class="tag keep">课堂末仍保留</span>'}</div>`;
        const shot = items.find((i) => i.image);
        if (shot) html += `<div class="bt-img"><img src="${shot.image}" loading="lazy" data-full="${shot.image}" alt="板书 ${fmtTime(shot.t)}"></div>`;
        for (const it of items) {
          html += `<div class="bt-item"><b>${fmtTime(it.t)}</b>${it.title ? ' · ' + esc(it.title) : ''}<div class="bt-body">${esc(it.text).slice(0, 1500)}</div></div>`;
        }
        html += '</div>';
      }
      html += '</div></div>';
      tail.push(html);
    }
    list.innerHTML = head.join('') + body + tail.join('');
    $$('#noteList img').forEach((im) => {
      if (!im.dataset.full) im.dataset.full = im.src;
      im.onclick = () => showLightbox(im.dataset.full);
    });
    attachImageAsk($('#noteList'));
    renderMath($('#noteList'));
  } catch (e) {
    /* 网络异常时保留已有内容 */
  }
}

/* ─────────────── 预览 ─────────────── */
function updatePreviewLinks() {
  const p = state.current; if (!p) return;
  const done = p.stage === 'done' || p.output?.html;
  $('#previewFrame').classList.toggle('hidden', !done);
  $('#linkHtml').classList.toggle('hidden', !done);
  $('#linkMd').classList.toggle('hidden', !done);
  if (done) {
    $('#previewFrame').src = `/api/projects/${p.id}/html`;
    $('#linkHtml').href = `/api/projects/${p.id}/html`;
    $('#linkMd').href = `/api/projects/${p.id}/file/${encodeURIComponent('notes.md')}?download`;
    $('#previewHint').textContent = '以下为成稿预览（与 PDF 排版一致）。';
    loadSupplements();
  }
  $('#aiSupp').classList.toggle('hidden', !done);
  const pdf = p.output?.pdf;
  const btn = $('#btnPdf');
  btn.classList.toggle('hidden', !pdf);
  if (pdf) btn.href = `/api/projects/${p.id}/file/${encodeURIComponent(pdf.split(/[\\/]/).pop())}`;
}

/* ─────────────── 日志 ─────────────── */
function addLog(msg, level = '') {
  state.logs.push({ msg, level });
  if (state.logs.length > 600) state.logs.splice(0, state.logs.length - 600);
  const pre = $('#logs');
  const span = document.createElement('div');
  if (level) span.className = 'l-' + level;
  span.textContent = `${new Date().toLocaleTimeString('zh-CN', { hour12: false })}  ${msg}`;
  pre.appendChild(span);
  if ($('#chkAutoScroll').checked) pre.scrollTop = pre.scrollHeight;
}

/* ─────────────── 事件处理 ─────────────── */
function applyEvent(ev, replay = false) {
  switch (ev.type) {
    case 'stage': {
      state.stage = ev.stage;
      state.current.stages = { ...(state.current.stages || {}), [ev.stage]: { status: ev.status } };
      state.current.stage = ev.stage;
      renderStages(); renderProjectHead();
      const label = (state.env?.stages || []).find((s) => s.id === ev.stage)?.label || ev.stage;
      const donePct = ev.status === 'done' ? within(ev.stage, 100) : state.percent;
      setBar(Math.max(state.percent, donePct), `${label}${ev.status === 'running' ? ' 进行中…' : ev.status === 'done' ? ' 完成' : ''}`);
      if (ev.status === 'running' && !replay) addLog(`▶ ${label}`);
      break;
    }
    case 'log': addLog(ev.message, ev.level || ''); if (ev.level === 'error') toast(ev.message, 'err'); break;
    case 'download-progress':
      setBar(within('prepare', ev.percent), `下载视频 ${ev.percent}%  ${ev.size || ''}  ${ev.speed || ''}`);
      break;
    case 'media-info':
      state.current.mediaInfo = ev.info;
      state.current.title = state.current.title || ev.title;
      renderProjectHead();
      addLog(`视频信息：${ev.info.width}×${ev.info.height}，时长 ${ev.durationText}，大小 ${ev.sizeText}`);
      break;
    case 'asr-progress':
      setBar(within('audio', ev.percent), `语音识别 ${ev.percent}%（第 ${ev.chunk}/${ev.total} 段）`);
      break;
    case 'probe-progress':
      setBar(within('visual', ev.percent), `扫描画面 ${ev.percent}%（已抓 ${ev.snapshots} 屏板书）`);
      break;
    case 'board-timeline':
      state.current.generations = ev.generations;
      addLog(`共识别出 ${ev.generations.length} 块板书区域`);
      break;
    case 'capture-point': break;
    case 'generation-end':
      if (ev.generation?.erased) addLog(`第 ${ev.generation.index + 1} 块板书写满后被擦除，已在擦除前保存`, 'ok');
      break;
    case 'read-progress':
      setBar(within('read', ev.percent), `识别板书 ${ev.percent}%（${ev.done}/${ev.total}）`);
      break;
    case 'board-ready': {
      const s = ev.snapshot;
      if (!state.snapshots.some((x) => x.t === s.t)) state.snapshots.push(s);
      state.snapshots.sort((a, b) => a.t - b.t);
      if (!replay) { renderBoard(); }
      setBar(within('read', ev.percent), `识别板书 ${ev.percent}%（${ev.done}/${ev.total}）`);
      break;
    }
    case 'note-progress':
      setBar(within('think', ev.percent), `整理笔记 ${ev.percent}%（第 ${ev.index + 1} 段：${ev.title || ''}）`);
      break;
    case 'section-done':
      state.sections[ev.section.index] = ev.section;
      state.sections = state.sections.filter(Boolean).sort((a, b) => a.index - b.index);
      scheduleNotesRefresh();
      break;
    case 'done':
      addLog(`✅ 全部完成：${ev.title}`, 'ok');
      setBar(100, '已完成');
      toast('笔记生成完成！', 'ok');
      loadProjectFresh();
      break;
    case 'rerender-done':
      toast('排版已更新', 'ok');
      loadProjectFresh();
      break;
    case 'failed':
      addLog(`❌ ${ev.message}`, 'error');
      setBar(state.percent, '已中断：' + ev.message);
      toast(ev.message, 'err');
      loadProjectFresh();
      break;
    case 'install-progress':
      state._resProgress = { ...(state._resProgress || {}), [ev.id]: ev };
      renderResList(state._resProgress);
      break;
    case 'install-done': {
      state._resProgress = {};
      addLog('资源安装结束', 'ok');
      refreshEnv();
      break;
    }
  }
}

async function loadProjectFresh() {
  if (!state.current) return;
  const data = await api.get('/api/projects/' + state.current.id);
  state.current = data;
  renderProjectHead(); updatePreviewLinks(); refreshProjects();
  renderNotes();
}

/* 章节陆续产出时，合并刷新，避免频繁请求 */
let notesTimer = null;
function scheduleNotesRefresh() {
  clearTimeout(notesTimer);
  notesTimer = setTimeout(() => renderNotes(), 1200);
}

/* ─────────────── SSE ─────────────── */
function connectSSE() {
  if (state.es) state.es.close();
  const es = new EventSource('/api/events');
  state.es = es;
  let downSince = 0;
  es.onopen = () => {
    downSince = 0;
    hideServerDown();
  };
  es.onmessage = (m) => {
    if (!m.data || m.data.startsWith(':')) return;
    let ev; try { ev = JSON.parse(m.data); } catch { return; }
    if (ev.type === 'server-exit') { showServerDown(ev.message); return; }
    if (ev.type === 'install-progress' || ev.type === 'install-done' || ev.type === 'install-start') { applyEvent(ev); return; }
    if (!state.current || ev.projectId !== state.current.id) { if (ev.type === 'install-done') refreshEnv(); return; }
    applyEvent(ev);
  };
  es.onerror = () => {
    es.close();
    if (!downSince) downSince = Date.now();
    // 连不上超过 12 秒，基本可以确定程序已经退出了
    if (Date.now() - downSince > 12000) showServerDown('程序已退出');
    else setTimeout(connectSSE, 2000);
  };
}

/** 程序退出后的友好提示（不再傻等着重连） */
function showServerDown(reason) {
  if ($('#serverDown')) return;
  const d = document.createElement('div');
  d.className = 'server-down';
  d.id = 'serverDown';
  d.innerHTML = `<div class="sd-card">
      <h3>程序已经退出了</h3>
      <p>${esc(reason || '')}${reason ? '：' : ''}关闭所有页面后，课程笔记工坊会自动结束运行，黑窗口也会一起关掉。</p>
      <p>想继续使用，请到 <code>C:\\Users\\USER\\Desktop\\CourseNoteStudio</code> 双击 <b>启动.bat</b>。</p>
      <button class="btn primary" onclick="location.reload()">重新连接</button>
    </div>`;
  document.body.appendChild(d);
}

function hideServerDown() {
  $('#serverDown')?.remove();
}

/* ─────────────── 新建任务 ─────────────── */
async function startNewProject() {
  const input = $('#inputUrl').value.trim();
  if (!input) { toast('请先粘贴视频链接或本地文件路径', 'warn'); $('#inputUrl').focus(); return; }
  const body = {
    input,
    title: $('#inputCourse').value.trim(),
    options: {
      density: $('#selDensity').value,
      courseName: $('#inputCourse').value.trim(),
      includeTranscript: $('#chkTranscript').checked,
      autoCrop: $('#chkCrop').checked,
    },
  };
  try {
    const p = await api.post('/api/projects', body);
    toast('任务已创建，开始处理…', 'ok');
    await refreshProjects();
    await openProject(p.id);
    await api.post(`/api/projects/${p.id}/run`, {});
    state.current.running = true;
    renderProjectHead();
  } catch (e) { toast(e.message, 'err'); }
}

/* ─────────────── 设置抽屉 ─────────────── */
async function openDrawer() {
  $('#drawer').classList.remove('hidden'); $('#drawerMask').classList.remove('hidden');
  if (location.hash !== '#/settings' && !location.hash.startsWith('#/p/')) location.hash = '#/settings';
  await refreshEnv();
  const cfg = await api.get('/api/config');
  $('#cfgLlmBase').value = cfg.llm.baseUrl || '';
  $('#cfgLlmModel').value = cfg.llm.model || '';
  $('#cfgLlmKey').value = '';
  $('#cfgLlmKey').placeholder = cfg.llm._keyReady
    ? `已配置（${cfg.llm._keyMasked}，${cfg.llm._keySource}），留空则不修改`
    : '粘贴你自己的 API Key（DeepSeek 或任意 OpenAI 兼容接口），必填';
  $('#cfgUseDsh').checked = !!cfg.llm.useDshKey;
  $('#cfgVlmMode').value = cfg.vlm.mode;
  $('#cfgVlmModel').innerHTML = (state.env?.vlm || []).map((v) => `<option value="${v.id}">${v.label}${v.ready ? '（已安装）' : '（未安装）'}</option>`).join('');
  $('#cfgVlmModel').value = cfg.vlm.modelId;
  $('#cfgVlmEndpoint').value = cfg.vlm.endpoint || '';
  $('#cfgVlmModelName').value = cfg.vlm.model || '';
  $('#cfgVlmKey').value = '';
  $('#cfgVlmGpu').value = cfg.vlm.gpuLayers;
  $('#cfgDensity').value = cfg.capture.density;
  $('#cfgMaxSnap').value = cfg.capture.maxSnapshots;
  $('#cfgImgWidth').value = cfg.capture.imageWidth;
  $('#cfgCookies').value = cfg.download.cookiesFromBrowser || '';
  $('#cfgCourse').value = cfg.output.courseName || '';
  $('#cfgIncludeTranscript').checked = !!cfg.output.includeTranscript;
  $('#cfgIncludeBoardImages').checked = !!cfg.output.includeBoardImages;
  $('#cfgIncludeBoardTimeline').checked = !!cfg.output.includeBoardTimeline;
}
function closeDrawer() { $('#drawer').classList.add('hidden'); $('#drawerMask').classList.add('hidden'); }

async function saveCfg() {
  const patch = {
    llm: {
      baseUrl: $('#cfgLlmBase').value.trim(), model: $('#cfgLlmModel').value.trim(),
      useDshKey: $('#cfgUseDsh').checked,
    },
    vlm: {
      mode: $('#cfgVlmMode').value, modelId: $('#cfgVlmModel').value,
      endpoint: $('#cfgVlmEndpoint').value.trim(), model: $('#cfgVlmModelName').value.trim(),
      gpuLayers: Number($('#cfgVlmGpu').value) || 0,
    },
    capture: {
      density: $('#cfgDensity').value, maxSnapshots: Number($('#cfgMaxSnap').value) || 300,
      imageWidth: Number($('#cfgImgWidth').value) || 1600,
    },
    download: { cookiesFromBrowser: $('#cfgCookies').value },
    output: {
      courseName: $('#cfgCourse').value.trim(),
      includeTranscript: $('#cfgIncludeTranscript').checked,
      includeBoardImages: $('#cfgIncludeBoardImages').checked,
      includeBoardTimeline: $('#cfgIncludeBoardTimeline').checked,
    },
  };
  const key = $('#cfgLlmKey').value.trim();
  if (key) patch.llm.apiKey = key;
  const vkey = $('#cfgVlmKey').value.trim();
  if (vkey) patch.vlm.apiKey = vkey;
  try {
    await api.post('/api/config', patch);
    $('#saveHint').textContent = '已保存 ✓  ' + new Date().toLocaleTimeString('zh-CN', { hour12: false });
    toast('设置已保存', 'ok');
    await refreshEnv();
  } catch (e) { toast(e.message, 'err'); }
}

/* ─────────────── 初始化 ─────────────── */
function bind() {
  $('#btnNew').onclick = () => goHome();
  $('#btnStart').onclick = startNewProject;
  $('#inputUrl').addEventListener('keydown', (e) => { if (e.key === 'Enter') startNewProject(); });
  $('#btnSettings').onclick = openDrawer;
  $('#btnCloseDrawer').onclick = closeDrawer;
  $('#drawerMask').onclick = closeDrawer;
  $('#btnSaveCfg').onclick = saveCfg;
  $('#btnStopVlm').onclick = async () => { try { await api.post('/api/vlm/stop', {}); toast('已停止视觉引擎，显存已释放', 'ok'); } catch (e) { toast(e.message, 'err'); } };
  $('#btnInstallCore').onclick = () => install(['ytdlp', 'ffmpeg', 'llamacpp-vulkan', 'sherpa', 'asr-sensevoice', 'asr-vad', 'asr-punct', 'vlm-qwen3vl-4b']);
  $('#btnInstallAll').onclick = () => install(['ytdlp', 'ffmpeg', 'llamacpp-vulkan', 'llamacpp-cpu', 'sherpa', 'asr-sensevoice', 'asr-vad', 'asr-punct', 'vlm-qwen3vl-4b', 'vlm-qwen25vl-3b']);
  $('#btnRun').onclick = async () => {
    if (!state.current) return;
    try {
      await api.post(`/api/projects/${state.current.id}/run`, {});
      state.current.running = true; renderProjectHead();
      addLog('▶ 开始处理');
    } catch (e) { toast(e.message, 'err'); }
  };
  $('#btnCancel').onclick = async () => { await api.post(`/api/projects/${state.current.id}/cancel`, {}); toast('已请求取消', 'warn'); };
  $('#btnReThink').onclick = async () => {
    if (!state.current) return;
    try {
      await api.post(`/api/projects/${state.current.id}/run`, { force: { think: true, render: true } });
      state.current.running = true; renderProjectHead();
      addLog('▶ 重新整理笔记（沿用已有板书识别结果）');
    } catch (e) { toast(e.message, 'err'); }
  };
  $('#btnReCapture').onclick = async () => {
    if (!state.current) return;
    if (!confirm('会用当前的抓拍策略重新扫描画面并重新识别板书（会再次调用视觉模型，耗时几分钟）。继续？')) return;
    try {
      await api.post(`/api/projects/${state.current.id}/run`, { force: { visual: true, read: true, think: true, render: true } });
      state.current.running = true; renderProjectHead();
      addLog('▶ 重新抓拍板书 + 重新识别（沿用已下载的视频与讲稿）');
    } catch (e) { toast(e.message, 'err'); }
  };
  $('#btnReRender').onclick = async () => {
    if (!state.current) return;
    try {
      await api.post(`/api/projects/${state.current.id}/rerender`, {});
      addLog('▶ 重新排版（沿用已有笔记内容，不调用模型）');
      toast('正在重新排版…', 'ok');
    } catch (e) { toast(e.message, 'err'); }
  };
  $('#btnDelete').onclick = async () => {
    if (!state.current) return;
    if (!confirm('确定删除这个任务？板书截图与已生成的 PDF 都会被删除。')) return;
    await api.del('/api/projects/' + state.current.id);
    state.current = null; switchView('home'); refreshProjects(); toast('已删除');
  };
  $('#btnClearLog').onclick = () => { $('#logs').textContent = ''; state.logs = []; };

  // AI 面板：常驻右栏，可收起
  $('#btnAiClose').onclick = () => aiToggle(false);
  $('#aiRail').onclick = () => aiToggle(true);
  $('#btnAiClear').onclick = async () => {
    if (!confirm('清空这个任务的 AI 对话记录？')) return;
    $('#aiThread').innerHTML = '<div class="ai-empty" id="aiEmpty">对话已清空。</div>';
    try { await api.post(`/api/projects/${state.current.id}/chat/clear`, {}); } catch {}
  };
  $('#btnAiSend').onclick = aiSend;
  $('#aiInput').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); aiSend(); }
  });
  $('#aiInput').addEventListener('input', (e) => {
    e.target.style.height = 'auto';
    e.target.style.height = Math.min(150, e.target.scrollHeight) + 'px';
  });
  setupSelectionAsk();
  setupContextMenu();
  setupResizers();

  // 全局搜索
  $('#searchInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') runSearch(); });
  $('#searchInput').addEventListener('input', (e) => { if (!e.target.value.trim()) { if (location.hash === '#/search') goHome(); } });
  $$('.side-search .seg').forEach((b) => (b.onclick = () => { searchSetMode(b.dataset.mode); if ($('#searchInput').value.trim()) runSearch(); }));
  $$('#viewSearch .seg').forEach((b) => (b.onclick = () => { searchSetMode(b.dataset.smode); runSearch(search.q); }));
  $('#btnSearchBack').onclick = () => (state.current ? (location.hash = `#/p/${state.current.id}`) : goHome());

  // AI 补充
  $('#btnSupp').onclick = () => runSupplements(false);
  $('#btnSuppRegen').onclick = () => { if (confirm('重新生成会覆盖现在的补充内容，继续？')) runSupplements(true); };
  $('#linkSupp').onclick = () => activateTab('supp');
  $('#chkSuppOn').onchange = (e) => { supp.on = e.target.checked; drawMarginNotes(); };
  $('#previewFrame').addEventListener('load', () => setTimeout(drawMarginNotes, 300));
  // 面板默认常驻（除非用户上次主动收起）
  aiToggle(localStorage.getItem('cns-ai-open') !== '0');
  $$('#tabs .tab, #tabsSub .tab').forEach((t) => t.onclick = () => {
    $$('#tabs .tab, #tabsSub .tab').forEach((x) => x.classList.toggle('active', x === t));
    $$('.pane').forEach((p) => p.classList.toggle('hidden', p.dataset.pane !== t.dataset.tab));
    if (t.dataset.tab === 'preview') setTimeout(drawMarginNotes, 350); // iframe 尺寸变了要重画
  });

  // 拖拽视频文件
  const drop = $('#dropHint');
  const main = document.body;
  main.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('over'); });
  main.addEventListener('dragleave', () => drop.classList.remove('over'));
  main.addEventListener('drop', async (e) => {
    e.preventDefault(); drop.classList.remove('over');
    const f = e.dataTransfer.files?.[0];
    if (!f) return;
    if (!/\.(mp4|mkv|flv|mov|webm|ts|avi|wmv)$/i.test(f.name)) return toast('请拖入视频文件（mp4/mkv/flv/mov/webm…）', 'warn');
    toast(`正在导入本地视频「${f.name}」…`);
    await uploadFile(f);
  });
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeDrawer();
    if (e.ctrlKey && e.key === 'Enter' && !$('#viewHome').classList.contains('hidden')) startNewProject();
  });
}

function uploadFile(file) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    const hint = $('#dropHint');
    xhr.open('POST', '/api/upload?name=' + encodeURIComponent(file.name));
    xhr.upload.onprogress = (e) => { if (e.lengthComputable) hint.textContent = `导入本地视频中 ${Math.round(e.loaded / e.total * 100)}%`; };
    xhr.onload = () => {
      try {
        const j = JSON.parse(xhr.responseText);
        if (j.path) {
          $('#inputUrl').value = j.path;
          hint.textContent = `已导入「${file.name}」，点击「开始生成」`;
          toast('本地视频已就绪，点击「开始生成」', 'ok');
          resolve(j);
        } else reject(new Error('上传失败'));
      } catch (e) { reject(e); }
    };
    xhr.onerror = () => reject(new Error('上传失败'));
    xhr.send(file);
  });
}

async function install(ids) {
  try {
    await api.post('/api/install', { ids });
    toast('开始下载安装，可在下方查看进度', 'ok');
  } catch (e) { toast(e.message, 'err'); }
}

(async function init() {
  initTheme();
  bind();
  await refreshEnv();
  await refreshProjects();
  await routeFromHash();
  const params = new URLSearchParams(location.search);
  const wantTab = params.get('tab');
  if (wantTab) activateTab(wantTab);
  if (params.get('ai') === '1') aiToggle(true);
  if (params.get('ctxdemo') === '1') setTimeout(() => window.__ctxDemo?.(), 1500);
  // 支持 /?q=关键词&mode=ai 直接搜索（可用于收藏夹/深链）
  const q0 = params.get('q');
  if (q0) {
    $('#searchInput').value = q0;
    searchSetMode(params.get('mode') === 'ai' ? 'ai' : 'exact');
    runSearch(q0);
  }
  window.addEventListener('hashchange', routeFromHash);
  // 支持 ?nosse 用于静态截图/调试（避免长连接让无头浏览器一直处于加载状态）
  if (!location.search.includes('nosse')) connectSSE();
  setInterval(refreshEnv, 20000);
})();
