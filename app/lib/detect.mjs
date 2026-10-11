// 板书时间线分析：逐秒扫描视频画面，找出「写完停笔」的稳定时刻、
// 擦除/切换时刻，从而在任何板书被擦掉之前把它抓下来。
//
// 核心思路：
//   1. 用 ffmpeg 把视频降采样成每秒一帧的灰度小图（384 宽），在 Node 里逐像素比较；
//   2. 先估计整体位移做补偿，抵消手持/机位抖动；
//   3. 每当相对「上次抓拍」已经积累出足够多的新内容，就在附近挑一帧最安静的记下来——
//      不依赖画面完全静止，因此在学生走动、镜头跟拍的教室里同样有效；
//   4. 抓拍时判断有没有大面积墨迹消失：有 = 擦黑板/换幻灯片，于是结束上一块板书、
//      开启新的一块。擦除前的那一屏在上一轮抓拍里已经存好，所以擦掉的内容不会丢；
//   5. 经常变化的画面区域（走动的人）自动降权；抓拍点过多时按块抽稀，但每块最后一屏必留。
import { ffmpeg, runBinary } from './proc.mjs';

const PROBE_WIDTH = 384;
const BLOCKS_X = 16;
const BLOCKS_Y = 9;

export function probeSize(srcW, srcH) {
  const w = PROBE_WIDTH;
  const h = Math.max(2, Math.round((PROBE_WIDTH * (srcH || 9)) / (srcW || 16) / 2) * 2);
  return { w, h };
}

const DENSITY_PRESETS = {
  // minGapSec：两次抓拍的最小间隔
  // settleSec：板书内容停止增长多久才算「老师写完了」——太短会抓到写一半的黑板
  // waitMaxSec：老师一直不停笔时的兜底上限
  // maxPerGeneration：每一块板书最终保留几屏。默认 1 = 只留「擦除前写得最全的那一屏」，
  //                   这样不会出现「刚起笔只写了两个字」的截图
  // completeRatio：若保留多屏，中间状态至少要有峰值的这个比例
  sparse: { motionThreshold: 0.0022, captureThreshold: 0.014, minGapSec: 25, settleSec: 8, waitMaxSec: 60, contentEps: 0.0016, maxPerGeneration: 1, completeRatio: 0.8 },
  balanced: { motionThreshold: 0.0018, captureThreshold: 0.008, minGapSec: 12, settleSec: 5.5, waitMaxSec: 40, contentEps: 0.0012, maxPerGeneration: 1, completeRatio: 0.8 },
  dense: { motionThreshold: 0.0014, captureThreshold: 0.0045, minGapSec: 6, settleSec: 4, waitMaxSec: 30, contentEps: 0.0008, maxPerGeneration: 3, completeRatio: 0.7 },
};

/** 把每块墨迹比例压成十六进制串，作为「板书内容指纹」。 */
function sigToHex(blockInk) {
  const bytes = Buffer.alloc(blockInk.length);
  for (let i = 0; i < blockInk.length; i++) bytes[i] = Math.max(0, Math.min(255, Math.round(blockInk[i] * 255)));
  return bytes.toString('hex');
}

/**
 * 一帧的签名：每块的墨迹比例（相对整幅画面的底色）。
 * 黑板/白板上的字相对底色差别很大，会被算作墨迹；这个量随书写单调增加，
 * 因此既能用来判断「老师还在写」，也能用来判断「这一屏写了多少」。
 */
function analyzeFrame(buf, w, h, inkThreshold) {
  const hist = new Int32Array(256);
  for (let i = 0; i < buf.length; i++) hist[buf[i]]++;
  let bg = 0;
  let best = -1;
  for (let v = 0; v < 256; v++) if (hist[v] > best) { best = hist[v]; bg = v; }

  const bw = Math.floor(w / BLOCKS_X);
  const bh = Math.floor(h / BLOCKS_Y);
  const blockInk = new Float32Array(BLOCKS_X * BLOCKS_Y);
  for (let by = 0; by < BLOCKS_Y; by++) {
    for (let bx = 0; bx < BLOCKS_X; bx++) {
      let ink = 0;
      let n = 0;
      const y0 = by * bh;
      const x0 = bx * bw;
      for (let y = y0; y < y0 + bh; y++) {
        const row = y * w;
        for (let x = x0; x < x0 + bw; x++) {
          const d = buf[row + x] - bg;
          if (d > inkThreshold || d < -inkThreshold) ink++;
          n++;
        }
      }
      blockInk[by * BLOCKS_X + bx] = n ? ink / n : 0;
    }
  }
  let inkSum = 0;
  for (let i = 0; i < blockInk.length; i++) inkSum += blockInk[i];
  // 另外统计「很亮的像素」占比：黑板上白粉笔的特征，和「人挡住黑板」区分开来
  let bright = 0;
  for (let i = 0; i < buf.length; i++) if (buf[i] > 175) bright++;
  return { bg, blockInk, inkTotal: inkSum / blockInk.length, bright: bright / buf.length };
}

/** 估计两帧之间的整体位移（抵消手持/机位抖动与缓慢平移）。 */
function estimateShift(cur, prev, w, h, maxShift = 8) {
  const step = 6;
  const margin = maxShift + 2;
  let bestDx = 0;
  let bestDy = 0;
  let bestCost = Infinity;
  for (let dy = -maxShift; dy <= maxShift; dy++) {
    for (let dx = -maxShift; dx <= maxShift; dx++) {
      let cost = 0;
      let n = 0;
      for (let y = margin; y < h - margin; y += step) {
        const rowA = y * w;
        const rowB = (y - dy) * w - dx;
        for (let x = margin; x < w - margin; x += step) {
          const d = cur[rowA + x] - prev[rowB + x];
          cost += d < 0 ? -d : d;
          n++;
        }
      }
      cost = n ? cost / n : 0;
      if (cost < bestCost) {
        bestCost = cost;
        bestDx = dx;
        bestDy = dy;
      }
    }
  }
  return { dx: bestDx, dy: bestDy };
}

/** 加权差异比例（0~1），带整体位移补偿；权重低的区域（走动的人）不计入。 */
function diffRatio(a, b, w, h, pxThreshold, weights, shift) {
  const bw = Math.floor(w / BLOCKS_X);
  const bh = Math.floor(h / BLOCKS_Y);
  const dx = shift ? shift.dx : 0;
  const dy = shift ? shift.dy : 0;
  const m = Math.max(Math.abs(dx), Math.abs(dy)) + 1;
  let changed = 0;
  let total = 0;
  for (let y = m; y < h - m; y++) {
    const by = Math.min(BLOCKS_Y - 1, Math.floor(y / bh));
    const rowA = y * w;
    const rowB = (y - dy) * w - dx;
    const wrow = by * BLOCKS_X;
    for (let x = m; x < w - m; x++) {
      const bx = Math.min(BLOCKS_X - 1, Math.floor(x / bw));
      const wt = weights[wrow + bx];
      total += wt;
      const d = a[rowA + x] - b[rowB + x];
      if (d > pxThreshold || d < -pxThreshold) changed += wt;
    }
  }
  return total > 0 ? changed / total : 0;
}

/** 逐块差异比例，用于定位「哪里变了」。 */
function blockDiffRatio(a, b, w, h, pxThreshold, shift) {
  const bw = Math.floor(w / BLOCKS_X);
  const bh = Math.floor(h / BLOCKS_Y);
  const dx = shift ? shift.dx : 0;
  const dy = shift ? shift.dy : 0;
  const out = new Float32Array(BLOCKS_X * BLOCKS_Y);
  for (let by = 0; by < BLOCKS_Y; by++) {
    for (let bx = 0; bx < BLOCKS_X; bx++) {
      let changed = 0;
      let n = 0;
      for (let y = by * bh; y < (by + 1) * bh; y++) {
        const rowA = y * w;
        const rowB = (y - dy) * w - dx;
        for (let x = bx * bw; x < (bx + 1) * bw; x++) {
          const d = a[rowA + x] - b[rowB + x];
          if (d > pxThreshold || d < -pxThreshold) changed++;
          n++;
        }
      }
      out[by * BLOCKS_X + bx] = n ? changed / n : 0;
    }
  }
  return out;
}

function countInk(blockInk) {
  let c = 0;
  for (let i = 0; i < blockInk.length; i++) if (blockInk[i] > 0.04) c++;
  return c;
}

/** 扫描整段视频，返回抓拍点列表（含自动裁剪区域）。 */
export async function probeVideo({ video, width, height, duration, options = {}, onEvent = () => {}, onFrame, signal }) {
  const density = DENSITY_PRESETS[options.density] || DENSITY_PRESETS.balanced;
  const cfg = {
    probeFps: options.probeFps ?? 1,
    pxThreshold: options.pxThreshold ?? 26,
    inkThreshold: options.inkThreshold ?? 45,
    eraseRatio: options.eraseRatio ?? 0.35,
    maxSnapshots: options.maxSnapshots ?? 300,
    autoCrop: options.autoCrop !== false,
    ...density,
  };

  const { w, h } = probeSize(width, height);
  const frameBytes = w * h;
  const nb = BLOCKS_X * BLOCKS_Y;
  const weights = new Float32Array(nb).fill(1);
  const dyn = new Float32Array(nb); // 该块「长期在动」的程度

  const args = [
    '-hide_banner', '-loglevel', 'error', '-nostdin',
    '-i', video,
    '-vf', `fps=${cfg.probeFps},scale=${w}:${h}`,
    '-pix_fmt', 'gray',
    '-f', 'rawvideo', '-',
  ];

  const { child, stderrRef } = await runBinary(ffmpeg.bin(), args, { signal });
  let buf = Buffer.alloc(0);
  const pending = [];
  child.stdout.on('data', (c) => pending.push(c));

  let prevFrame = null;
  let refFrame = null;
  let refSig = null;

  const points = [];
  const generations = [];
  let gen = { index: 0, startTime: 0, endTime: null, erased: false, reason: 'start', snapshots: 0 };
  generations.push(gen);

  let idx = -1;
  let lastCaptureTime = 0;
  let lastEmittedContent = 0; // 上次抓拍时板书的内容量，用来判断「有没有真的多出新内容」
  let lastReport = -1;
  let pendingCap = null; // 正在等待「写完整」的抓拍
  const everInk = new Uint8Array(nb);

  // 「稳定内容」：最近若干帧的逐块中位数，滤掉老师走动造成的瞬时遮挡
  const STABLE_WINDOW = 7;
  const inkHist = [];
  const stableBuf = new Float32Array(nb);
  const sortTmp = new Float32Array(STABLE_WINDOW);
  let stableContent = 0;
  let refStable = null; // 上次抓拍时的稳定内容
  let bestBoard = null; // 到目前为止「写得最全」的一屏（擦除时用它抢救内容）
  const recent = []; // 最近几帧，用于挑遮挡最少的一帧

  const updateStable = () => {
    const n = inkHist.length;
    let sum = 0;
    for (let b = 0; b < nb; b++) {
      for (let i = 0; i < n; i++) sortTmp[i] = inkHist[i][b];
      for (let i = 1; i < n; i++) {
        const v = sortTmp[i];
        let j = i - 1;
        while (j >= 0 && sortTmp[j] > v) {
          sortTmp[j + 1] = sortTmp[j];
          j--;
        }
        sortTmp[j + 1] = v;
      }
      const med = sortTmp[n >> 1];
      stableBuf[b] = med;
      sum += med;
    }
    stableContent = n ? sum / nb : 0;
  };

  /**
   * 在候选帧里挑与给定内容最接近的一帧（＝板书被遮挡最少的一帧）。
   * 只用「长期不怎么动」的块来比较（也就是黑板本身），
   * 老师站的位置那些块会被降权，否则选出来的只是「老师刚好不在这儿」而不是「板书最全」。
   */
  const pickClosest = (frames, target) => {
    let best = frames[0];
    let bestDist = Infinity;
    for (const f of frames) {
      let d = 0;
      for (let b = 0; b < nb; b++) d += Math.abs(f.sig.blockInk[b] - target[b]) * (1 - dyn[b]);
      if (d < bestDist) {
        bestDist = d;
        best = f;
      }
    }
    return best;
  };

  /** 结束当前板书块，开启新的一块。 */
  const closeGeneration = (erased, atTime) => {
    gen.endTime = atTime;
    gen.erased = erased;
    gen.reason = erased ? 'erase' : 'scene';
    onEvent({ type: 'generation-end', generation: { ...gen } });
    gen = {
      index: gen.index + 1,
      startTime: atTime,
      endTime: null,
      erased: false,
      reason: erased ? 'after-erase' : 'after-scene',
      snapshots: 0,
    };
    generations.push(gen);
  };

  const emitPoint = (t, reason, sig, frame, stableInk, content) => {
    if (points.length >= cfg.maxSnapshots) return null;
    const p = {
      index: points.length,
      t: Math.round(t * 10) / 10,
      reason,
      generation: gen.index,
      inkTotal: sig ? Number(sig.inkTotal.toFixed(5)) : 0,
      content: Number((content ?? stableContent).toFixed(5)), // 板书内容量，用于挑「写得最全」的一屏
      sig: sig ? sigToHex(sig.blockInk) : '',
    };
    points.push(p);
    gen.snapshots++;
    lastCaptureTime = t;
    refSig = sig;
    refStable = Float32Array.from(stableInk || stableBuf); // 记住这一屏的稳定内容，用于判断之后有没有被擦掉
    if (frame) refFrame = Buffer.from(frame);
    onEvent({ type: 'capture-point', point: p });
    return p;
  };

  /**
   * 判断当前这一屏相对「上次抓拍时的稳定内容」发生了什么：
   * 大面积墨迹消失 = 擦黑板 / 换幻灯片 → 开新的一块板书。
   */
  const classify = (sig) => {
    const before = refStable;
    if (!before) return { erased: false, scene: false };
    let lost = 0;
    let gained = 0;
    for (let b = 0; b < nb; b++) {
      if (before[b] > 0.04 && sig.blockInk[b] < before[b] * 0.4) lost++;
      if (sig.blockInk[b] > 0.04 && sig.blockInk[b] > before[b] * 2.0) gained++;
    }
    const beforeCount = countInk(before);
    const eraseFrac = beforeCount ? lost / beforeCount : 0;
    const erased = lost >= 3 && eraseFrac >= cfg.eraseRatio;
    // 换幻灯片：旧内容几乎全没了，同时出现大量新内容
    const scene = !erased && lost >= 3 && gained >= 3 && beforeCount > 0 && lost / beforeCount >= 0.5;
    return { erased, scene };
  };

  const processFrames = () => {
    while (pending.length) {
      const chunk = pending.shift();
      buf = buf.length ? Buffer.concat([buf, chunk]) : chunk;
      while (buf.length >= frameBytes) {
        const frame = buf.subarray(0, frameBytes);
        buf = buf.subarray(frameBytes);
        idx++;
        const t = idx / cfg.probeFps;
        const sig = analyzeFrame(frame, w, h, cfg.inkThreshold);
        for (let b = 0; b < nb; b++) if (sig.blockInk[b] > 0.05) everInk[b] = 1;

        // 维护最近若干帧的墨迹，取逐块中位数作为「稳定内容」：
        // 老师从黑板前走过只会影响一两帧，中位数能滤掉；写上去的字会留下来。
        inkHist.push(sig.blockInk);
        if (inkHist.length > STABLE_WINDOW) inkHist.shift();
        updateStable();
        const content = stableContent;

        // 记住最近几帧 + 「写得最全」的那一屏
        recent.push({ time: t, sig, frame: Buffer.from(frame) });
        if (recent.length > STABLE_WINDOW) recent.shift();
        if (!bestBoard || content > bestBoard.content + 0.0006) {
          const pick = pickClosest(recent, stableBuf);
          bestBoard = {
            time: pick.time,
            content,
            sig: pick.sig,
            ink: Float32Array.from(stableBuf),
            frame: pick.frame,
          };
        }

        if (!prevFrame) {
          prevFrame = Buffer.from(frame);
          refFrame = Buffer.from(frame);
          refSig = sig;
          refStable = Float32Array.from(stableBuf);
          continue;
        }

        // 先估计整体位移，抵消镜头抖动
        const shiftPrev = estimateShift(frame, prevFrame, w, h);
        const shiftRef = estimateShift(frame, refFrame, w, h);
        const motionBlocks = blockDiffRatio(frame, prevFrame, w, h, cfg.pxThreshold, shiftPrev);
        for (let b = 0; b < nb; b++) {
          dyn[b] = dyn[b] * 0.985 + motionBlocks[b] * 0.015;
          weights[b] = Math.max(0.03, 1 - dyn[b] * 8);
        }

        const motion = diffRatio(frame, prevFrame, w, h, cfg.pxThreshold, weights, shiftPrev);
        const refDiff = diffRatio(frame, refFrame, w, h, cfg.pxThreshold, weights, shiftRef);
        if (onFrame) onFrame({ t, motion, refDiff, content, bright: sig.bright, isMoving: motion > cfg.motionThreshold, shift: shiftPrev });

        // ── 抓拍决策：
        //    1) 相对上次抓拍，板书内容明显增多了 → 进入「等待」状态；
        //    2) 等待期间把每一帧都留着，等老师停笔；
        //    3) 内容连续几秒不再增长（停笔了）→ 抓拍。抓哪一帧？选「与稳定内容最接近」的那一帧，
        //       也就是老师遮挡最少、最能代表这一屏完整板书的一帧；
        //    4) 老师一直写个不停时，最多等 waitMaxSec 就抓；
        //    5) 等待期间若发生擦黑板，立刻把「擦除前」的内容存下来，保证擦掉的不丢。
        const takePending = (reason) => {
          const p = pendingCap;
          const { erased, scene } = classify({ blockInk: stableBuf });
          if (erased || scene) {
            // 黑板被擦掉/换页了：先把「擦除前写得最全的那一屏」存下来（属于上一块板书）
            let endTime = p.since;
            if (bestBoard && bestBoard.content > lastEmittedContent + cfg.contentEps) {
              emitPoint(bestBoard.time, 'pre-erase', bestBoard.sig, bestBoard.frame, bestBoard.ink, bestBoard.content);
              endTime = bestBoard.time;
            }
            closeGeneration(erased, endTime);
            // 新的一块从「当前」开始比较，避免把新板书又判成一次擦除
            refStable = Float32Array.from(stableBuf);
            lastEmittedContent = content;
          } else {
            // 正常抓拍：在等待窗口里挑与稳定内容最接近（遮挡最少）的一帧
            const best = pickClosest(p.frames, stableBuf);
            if (stableContent > lastEmittedContent + cfg.contentEps) {
              emitPoint(best.time, reason, best.sig, best.frame);
              lastEmittedContent = stableContent;
            }
          }
          pendingCap = null;
          bestBoard = null;
        };

        if (!pendingCap) {
          if (refDiff > cfg.captureThreshold && t - lastCaptureTime >= cfg.minGapSec) {
            pendingCap = {
              since: t,
              lastGrow: t,
              peakContent: content,
              frames: [{ time: t, sig, frame: Buffer.from(frame) }],
              motions: [motion],
            };
          }
        } else {
          const p = pendingCap;
          if (content > p.peakContent + 0.0006) {
            p.peakContent = content;
            p.lastGrow = t; // 还在往上写
          }
          p.frames.push({ time: t, sig, frame: Buffer.from(frame) });
          p.motions.push(motion);
          if (p.frames.length > 90) {
            p.frames.shift();
            p.motions.shift();
          }
          const settled = t - p.lastGrow >= cfg.settleSec; // 内容不再增长 = 大致写完了
          const timedOut = t - p.since >= cfg.waitMaxSec; // 一直写个不停
          const wiped = content < p.peakContent * 0.6; // 突然被擦掉大半
          // 就算「内容不再增长」，老师的手可能还在黑板前慢慢写。
          // 再要求这一帧本身够安静（明显低于这段时间的常态）才真正按下快门。
          let quietEnough = true;
          if (settled && p.motions.length >= 5 && !timedOut) {
            const sorted = [...p.motions].sort((a, b) => a - b);
            quietEnough = motion <= sorted[Math.floor(sorted.length * 0.4)];
          }
          if ((settled && quietEnough) || timedOut || wiped) takePending('content');
        }

        prevFrame = Buffer.from(frame);
        if (duration) {
          const pct = Math.min(99, Math.floor((t / duration) * 100));
          if (pct >= lastReport + 2) {
            lastReport = pct;
            onEvent({ type: 'probe-progress', percent: pct, time: t, snapshots: points.length });
          }
        }
      }
    }
  };

  const timer = setInterval(processFrames, 50);
  await new Promise((resolve, reject) => {
    child.on('close', () => {
      clearInterval(timer);
      processFrames();
      resolve();
    });
    child.on('error', reject);
  });
  clearInterval(timer);

  // 结尾：如果还在等待抓拍，就把这一屏最完整的一帧补上
  if (pendingCap) {
    const { erased, scene } = classify({ blockInk: stableBuf });
    let best = pendingCap.frames[0];
    let bestDist = Infinity;
    for (const f of pendingCap.frames) {
      let d = 0;
      for (let b = 0; b < nb; b++) d += Math.abs(f.sig.blockInk[b] - stableBuf[b]) * (1 - dyn[b]);
      if (d < bestDist) {
        bestDist = d;
        best = f;
      }
    }
    if (erased || scene) {
      gen.endTime = best.time;
      gen.erased = erased;
      gen.reason = erased ? 'erase' : 'scene';
      onEvent({ type: 'generation-end', generation: { ...gen } });
      gen = { index: gen.index + 1, startTime: best.time, endTime: null, erased: false, reason: 'after-erase', snapshots: 0 };
      generations.push(gen);
    }
    emitPoint(best.time, 'final', best.sig, best.frame);
    pendingCap = null;
  } else if (refFrame && refSig && duration && lastCaptureTime < duration - 2) {
    emitPoint(Math.min(duration, lastCaptureTime + 1), 'final', refSig, refFrame);
  }
  gen.endTime = duration ?? lastCaptureTime;
  onEvent({ type: 'generation-end', generation: { ...gen } });

  // ---- 自动裁剪：用「出现过墨迹、且不是长期动态区域」的块推断板书范围
  let crop = null;
  if (cfg.autoCrop && idx > 3) {
    let minX = BLOCKS_X;
    let minY = BLOCKS_Y;
    let maxX = -1;
    let maxY = -1;
    for (let by = 0; by < BLOCKS_Y; by++) {
      for (let bx = 0; bx < BLOCKS_X; bx++) {
        const b = by * BLOCKS_X + bx;
        if (everInk[b] && dyn[b] < 0.2) {
          minX = Math.min(minX, bx);
          maxX = Math.max(maxX, bx);
          minY = Math.min(minY, by);
          maxY = Math.max(maxY, by);
        }
      }
    }
    if (maxX >= 0) {
      const bw = w / BLOCKS_X;
      const bh = h / BLOCKS_Y;
      const padX = bw * 1.2;
      const padY = bh * 1.4;
      const x0 = Math.max(0, minX * bw - padX);
      const y0 = Math.max(0, minY * bh - padY);
      const x1 = Math.min(w, (maxX + 1) * bw + padX);
      const y1 = Math.min(h, (maxY + 1) * bh + padY);
      const sx = width / w;
      const sy = height / h;
      const c = {
        x: Math.max(0, Math.round(x0 * sx)),
        y: Math.max(0, Math.round(y0 * sy)),
        w: Math.round((x1 - x0) * sx),
        h: Math.round((y1 - y0) * sy),
      };
      c.w = Math.min(c.w, width - c.x);
      c.h = Math.min(c.h, height - c.y);
      c.w -= c.w % 2;
      c.h -= c.h % 2;
      if (c.w > 80 && c.h > 60 && c.w * c.h >= width * height * 0.05) crop = c;
    }
    onEvent({
      type: 'log',
      message: crop ? `已锁定板书区域：${crop.w}×${crop.h}（原画面 ${width}×${height}）` : '未能锁定板书区域，使用整幅画面识别',
    });
  }

  const withRoi = selectComplete(points, generations, cfg).map((p) => ({ ...p, roi: crop }));
  const tail = stderrRef ? stderrRef() : '';
  return {
    points: withRoi,
    generations,
    probe: { w, h, blocksX: BLOCKS_X, blocksY: BLOCKS_Y },
    meta: { frames: idx + 1, density: options.density || 'balanced', crop, cfg, stderr: tail.slice(-400) },
  };
}

/**
 * 决定每一块板书最终保留哪一屏。
 * 默认每块只留一屏——「擦除前写得最全的那一屏」（没被擦掉的板书记最后那一屏）。
 * 这样既完整（这一屏包含这块板书上写过的全部内容），又不会出现
 * 「刚起笔只写了两个字」或几屏几乎重复的截图。
 * 抓拍密度设为「密集」时会额外保留若干「已经写得比较满」的中间状态。
 */
export function selectComplete(points, generations, cfg = {}) {
  const ratio = cfg.completeRatio ?? 0.8;
  const maxPerGen = cfg.maxPerGeneration ?? 1;
  const out = [];
  for (const g of generations) {
    const own = points.filter((p) => p.generation === g.index);
    if (!own.length) continue;
    const peak = own.reduce((m, p) => Math.max(m, p.content || 0), 0);
    if (peak <= 0) continue; // 空黑板不留
    // 写得最全的那一屏（有擦除时，正好就是擦除前的那一屏）
    const fullest = own.reduce((a, b) => ((b.content || 0) > (a.content || 0) ? b : a), own[0]);
    const kept = [fullest];
    const quota = maxPerGen - 1;
    if (quota > 0) {
      const middles = own.filter((p) => p !== fullest && (p.content || 0) >= peak * ratio);
      if (middles.length) {
        const n = Math.min(quota, middles.length);
        for (let i = 0; i < n; i++) {
          kept.push(middles[Math.round((i * (middles.length - 1)) / Math.max(1, n - 1))]);
        }
      }
    }
    const uniq = [...new Set(kept)].sort((a, b) => a.t - b.t);
    out.push(...uniq);
    g.snapshots = uniq.length;
  }
  return out.sort((a, b) => a.t - b.t);
}

/**
 * 抓拍点过多时抽稀：保留每块板书的最后状态（擦除前最完整的一屏）、第一屏，
 * 以及块内均匀分布的中间状态。抽稀不会跨越板书边界，因此不会丢板书。
 */
function thinPoints(points, generations, max) {
  if (points.length <= max) return points;
  const keep = new Set();
  for (const g of generations) {
    const own = points.filter((p) => p.generation === g.index);
    if (!own.length) continue;
    keep.add(own[own.length - 1].index);
    keep.add(own[0].index);
  }
  const budget = Math.max(generations.length * 2, max);
  const remaining = Math.max(0, budget - keep.size);
  const byGen = new Map();
  for (const p of points) {
    if (keep.has(p.index)) continue;
    const arr = byGen.get(p.generation) || [];
    arr.push(p);
    byGen.set(p.generation, arr);
  }
  const totalLeft = [...byGen.values()].reduce((a, v) => a + v.length, 0);
  for (const arr of byGen.values()) {
    const quota = Math.max(1, Math.round((arr.length / Math.max(1, totalLeft)) * remaining));
    if (arr.length <= quota) {
      arr.forEach((p) => keep.add(p.index));
      continue;
    }
    for (let i = 0; i < quota; i++) {
      const at = Math.round((i * (arr.length - 1)) / Math.max(1, quota - 1));
      keep.add(arr[at].index);
    }
  }
  return points.filter((p) => keep.has(p.index));
}
