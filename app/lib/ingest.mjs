// 素材获取：下载网络视频 / 读取本地视频，抽出音轨与元数据。
import path from 'node:path';
import fs from 'node:fs';
import { ffmpeg, ffprobeJson, run, findYtDlp } from './proc.mjs';
import { humanSize, findFfmpeg, TOOLS_DIR } from './paths.mjs';

export function isUrl(s) {
  return /^https?:\/\//i.test((s || '').trim());
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
