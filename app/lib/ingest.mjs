// 素材获取：下载网络视频 / 读取本地视频，抽出音轨与元数据。
import path from 'node:path';
import fs from 'node:fs';
import { ffmpeg, ffprobeJson, run, findYtDlp } from './proc.mjs';
import { humanSize, findFfmpeg, TOOLS_DIR } from './paths.mjs';

export function isUrl(s) {
  return /^https?:\/\//i.test((s || '').trim());
}

/**
 * 从「分享文案」里抠出真正的视频地址。
 *
 * 各平台的分享按钮复制出来的通常是一整句，例如：
 *   【数学物理方法（武汉大学）周国全老师 1080p高清修复（全集）】https://www.bilibili.com/video/BV1Kj411v7jx?p=24&vd_source=713f...
 * 直接粘进来不能下载，用户还得手动删中文，很烦。
 *
 * 这里做三件事：
 *   1. 找出第一个 http(s) 链接（自动丢掉【】、《》与说明文字）；
 *   2. 只给了 BV 号 / av 号时也能拼出链接；
 *   3. 去掉 vd_source、spm_id_from 这类**分享跟踪参数**，
 *      保留 p（第几集）、list/index（播放列表）、t（时间点）这些有意义的参数。
 */
const TRACKING_PARAMS = new Set([
  'vd_source', 'spm_id_from', 'from_source', 'from_spmid', 'share_source', 'share_medium',
  'share_plat', 'share_tag', 'share_times', 'bbid', 'ts', 'timestamp', 'unique_k', 'seid',
  'buvid', 'up_id', 'si', 'utm_source', 'utm_medium', 'utm_campaign', 'utm_term',
  'utm_content', 'fbclid', 'gclid', 'feature',
]);

export function normalizeVideoInput(raw) {
  const text = String(raw || '').trim();
  if (!text) return '';
  // 本地文件路径（盘符 / UNC / 拖拽进来的）原样返回
  if (/^[a-zA-Z]:[\\/]/.test(text) || /^\\\\/.test(text)) return text;

  let url = (text.match(/https?:\/\/[^\s"'<>「」【】（）()《》，,、]+/i) || [])[0] || '';
  if (!url) {
    const bv = text.match(/\b(BV[0-9A-Za-z]{8,12})\b/);
    const av = text.match(/\b(av\d{5,12})\b/i);
    if (bv) url = `https://www.bilibili.com/video/${bv[1]}`;
    else if (av) url = `https://www.bilibili.com/video/${av[1]}`;
    else return text; // 既没有链接也不是路径，交给后面按文件处理
  }
  try {
    const u = new URL(url);
    for (const k of [...u.searchParams.keys()]) {
      if (TRACKING_PARAMS.has(k.toLowerCase())) u.searchParams.delete(k);
    }
    url = u.toString().replace(/\?$/, '');
  } catch {}
  return url;
}

/**
 * 列出一个合集 / 多 P 视频里的所有选集。
 *
 * 为什么不用 yt-dlp 一把梭：B 站多 P 视频用 --flat-playlist 拿不到标题和时长
 * （entries 里只有 url），而官方的分P接口一次请求就能拿到全部标题与时长，
 * 免登录、秒回，所以我们优先用它；其它平台再退回 yt-dlp。
 */
export async function listParts(rawUrl) {
  const input = normalizeVideoInput(rawUrl);
  const bv = input.match(/bilibili\.com\/video\/(BV[0-9A-Za-z]+)/i);
  if (bv) {
    const bvid = bv[1];
    const r = await fetch(`https://api.bilibili.com/x/player/pagelist?bvid=${bvid}`, {
      headers: { 'user-agent': 'Mozilla/5.0', referer: 'https://www.bilibili.com/' },
      signal: AbortSignal.timeout(15000),
    });
    const j = await r.json();
    if (j.code !== 0) throw new Error(`B 站返回错误：${j.message || j.code}`);
    const parts = (j.data || []).map((p) => ({
      index: p.page,
      title: String(p.part || `第 ${p.page} 集`).trim(),
      duration: Number(p.duration) || 0,
      url: `https://www.bilibili.com/video/${bvid}?p=${p.page}`,
    }));
    if (!parts.length) throw new Error('这个视频没有分 P');
    return { platform: 'bilibili', id: bvid, title: bvid, parts };
  }

  // 其它平台：让 yt-dlp 列出播放列表/合集
  const bin = findYtDlp();
  if (!bin) throw new Error('还没安装 yt-dlp，无法读取合集');
  const { code, stdout, stderr } = await run(bin, ['-J', '--flat-playlist', '--no-warnings', input], { timeoutMs: 120000 });
  if (code !== 0) {
    throw new Error(`读取合集失败：${String(stderr || '').split('\n').filter(Boolean).slice(-1)[0] || code}`);
  }
  const data = JSON.parse(stdout);
  const entries = data.entries || [];
  if (!entries.length) throw new Error('这个链接里没有找到选集（可能是单个视频）');
  return {
    platform: 'generic',
    id: data.id || '',
    title: data.title || '',
    parts: entries.map((e, i) => ({
      index: i + 1,
      title: String(e.title || `第 ${i + 1} 集`).trim(),
      duration: Number(e.duration) || 0,
      url: e.url || e.webpage_url || '',
    })),
  };
}

/** 探测媒体信息。 */
export async function probeMedia(file) {
  const info = await ffprobeJson(file);
  const v = (info.streams || []).find((s) => s.codec_type === 'video');
  const a = (info.streams || []).find((s) => s.codec_type === 'audio');
  return {
    duration: Number(info.format?.duration || 0),
    size: Number(info.format?.size || 0),
    width: v?.width || 0,
    height: v?.height || 0,
    fps: v?.avg_frame_rate ? evalFps(v.avg_frame_rate) : 0,
    videoCodec: v?.codec_name || '',
    hasAudio: !!a,
    audioCodec: a?.codec_name || '',
    title: info.format?.tags?.title || '',
  };
}

function evalFps(s) {
  const [n, d] = String(s).split('/').map(Number);
  return d ? Math.round((n / d) * 100) / 100 : 0;
}

/** 用 yt-dlp 下载视频。 */
export async function downloadVideo({ url, outDir, quality = '1080', cookiesFromBrowser = '', section = '', onEvent = () => {}, signal }) {
  fs.mkdirSync(outDir, { recursive: true });
  const template = path.join(outDir, 'source.%(ext)s');
  const height = String(quality).replace(/[^0-9]/g, '') || '1080';
  const args = [
    '--no-playlist',
    '--no-warnings',
    '--newline',
    '--no-mtime',
    '--merge-output-format', 'mp4',
    '-f', `bv*[height<=${height}]+ba/b[height<=${height}]/bv*+ba/b`,
    '-o', template,
    '--write-info-json',
    '--print', 'after_move:filepath',
  ];
  // yt-dlp 合并音视频 / 截取片段都要用 ffmpeg，必须显式告诉它 ffmpeg 在哪
  const ffDir = path.dirname(findFfmpeg());
  if (fs.existsSync(path.join(ffDir, 'ffmpeg.exe'))) args.push('--ffmpeg-location', ffDir);
  if (section) {
    // 只下载指定时间段，例如 00:10:00-00:14:00
    args.push('--download-sections', `*${section}`, '--force-keyframes-at-cuts');
  }
  if (cookiesFromBrowser) args.push('--cookies-from-browser', cookiesFromBrowser);
  args.push(url);

  let lastLine = '';
  const r = await run(findYtDlp(), args, {
    signal,
    timeoutMs: 1000 * 60 * 60 * 3,
    onLine: (line) => {
      if (line === lastLine) return;
      lastLine = line;
      const m = line.match(/\[download\]\s+([\d.]+)%\s+of\s+~?\s*([\d.]+)(\w+)(?:\s+at\s+(\S+))?/);
      if (m) {
        onEvent({
          type: 'download-progress',
          percent: Number(m[1]),
          size: `${m[2]}${m[3]}`,
          speed: m[4] || '',
          line,
        });
      } else if (/\[(Merger|Fixup|ExtractAudio|Metadata)\]/.test(line) || /Destination|has already been downloaded|Deleting original/i.test(line)) {
        onEvent({ type: 'log', message: line.replace(/^\[[^\]]+\]\s*/, '') });
      } else if (/ERROR/i.test(line)) {
        onEvent({ type: 'log', level: 'error', message: line });
      }
    },
  });
  if (r.code !== 0) {
    const err = (r.stderr || '').split('\n').filter((l) => /ERROR/i.test(l)).join(' ').slice(0, 400);
    throw new Error(`视频下载失败：${err || r.stderr.slice(-300) || '未知错误'}`);
  }
  const printed = r.stdout
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter((s) => s && !s.startsWith('[') && fs.existsSync(s));
  const candidates = [
    ...printed.reverse(),
    ...fs.readdirSync(outDir).filter((f) => /^source\.(mp4|mkv|webm|flv|ts|mov)$/i.test(f)).map((f) => path.join(outDir, f)),
  ];
  const file = candidates.find((f) => fs.existsSync(f));
  if (!file) throw new Error('下载完成但未找到输出文件');
  return file;
}

/** 抽音轨为 16k 单声道 wav。 */
export async function extractAudio({ video, outFile, onEvent = () => {}, signal }) {
  if (fs.existsSync(outFile) && fs.statSync(outFile).size > 1024) {
    onEvent({ type: 'log', message: '音轨已存在，跳过提取' });
    return outFile;
  }
  const r = await run(
    ffmpeg.bin(),
    ['-hide_banner', '-loglevel', 'error', '-nostdin', '-i', video, '-vn', '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', '-y', outFile],
    { timeoutMs: 1000 * 60 * 30, signal },
  );
  if (r.code !== 0) throw new Error(`提取音轨失败：${r.stderr.slice(0, 300)}`);
  onEvent({ type: 'log', message: `音轨提取完成（${humanSize(fs.statSync(outFile).size)}）` });
  return outFile;
}

/** 读取 yt-dlp 写下的 info.json，取标题等信息。 */
export function readInfoJson(outDir) {
  try {
    const f = fs.readdirSync(outDir).find((x) => x.endsWith('.info.json'));
    if (!f) return null;
    const j = JSON.parse(fs.readFileSync(path.join(outDir, f), 'utf8'));
    return {
      title: j.title || '',
      uploader: j.uploader || j.channel || '',
      duration: j.duration || 0,
      uploadDate: j.upload_date || '',
      description: (j.description || '').slice(0, 2000),
      webpageUrl: j.webpage_url || '',
      thumbnail: j.thumbnail || '',
    };
  } catch {
    return null;
  }
}
