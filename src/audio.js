/**
 * audio.js — 真实音频处理 + 共振峰(Formant)语音合成
 *  - 上传音频：Web Audio 真实解码 → 波形 / 频谱 / 音高 / 音色特征
 *  - 合成语音：源-滤波器模型（声门脉冲 + 3 级共振峰），参数由目标说话人特征驱动
 *  - 输出：Float32Array，可绘制、播放、导出 wav
 */

export const SR = 24000;

/* ══════════════════ FFT ══════════════════ */
function nextPow2(n) { let p = 1; while (p < n) p <<= 1; return p; }

export function fft(re, im) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) { [re[i], re[j]] = [re[j], re[i]]; [im[i], im[j]] = [im[j], im[i]]; }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    const wr = Math.cos(ang), wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const ur = re[i + k], ui = im[i + k];
        const vr = re[i + k + len / 2] * cr - im[i + k + len / 2] * ci;
        const vi = re[i + k + len / 2] * ci + im[i + k + len / 2] * cr;
        re[i + k] = ur + vr; im[i + k] = ui + vi;
        re[i + k + len / 2] = ur - vr; im[i + k + len / 2] = ui - vi;
        const ncr = cr * wr - ci * wi;
        ci = cr * wi + ci * wr; cr = ncr;
      }
    }
  }
}

function hann(n) {
  const w = new Float32Array(n);
  for (let i = 0; i < n; i++) w[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (n - 1));
  return w;
}

/** 短时傅里叶变换 → 幅度谱帧 */
export function stft(samples, { fftSize = 512, hop = 256 } = {}) {
  const win = hann(fftSize);
  const frames = [];
  const half = fftSize / 2 + 1;
  for (let start = 0; start + fftSize <= samples.length; start += hop) {
    const re = new Float64Array(fftSize), im = new Float64Array(fftSize);
    for (let i = 0; i < fftSize; i++) re[i] = samples[start + i] * win[i];
    fft(re, im);
    const mag = new Float32Array(half);
    for (let k = 0; k < half; k++) mag[k] = Math.hypot(re[k], im[k]);
    frames.push(mag);
  }
  return frames;
}

/* ══════════════════ 解码 / 分析 ══════════════════ */
export async function decodeFile(file) {
  const buf = await file.arrayBuffer();
  const Ctx = window.AudioContext || window.webkitAudioContext;
  const ctx = new Ctx();
  const audio = await ctx.decodeAudioData(buf.slice(0));
  // 混为单声道
  const ch = audio.numberOfChannels;
  const len = audio.length;
  const mono = new Float32Array(len);
  for (let c = 0; c < ch; c++) {
    const d = audio.getChannelData(c);
    for (let i = 0; i < len; i++) mono[i] += d[i] / ch;
  }
  const sr = audio.sampleRate;
  await ctx.close();
  return { samples: mono, sr, duration: len / sr, name: file.name };
}

const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

/** 基于自相关估计基频（median of voiced frames） */
export function estimateF0(samples, sr) {
  const frame = 1024, hop = 512;
  const minLag = Math.floor(sr / 420), maxLag = Math.floor(sr / 65);
  const est = [];
  for (let start = 0; start + frame <= samples.length; start += hop) {
    let rms = 0;
    for (let i = 0; i < frame; i++) rms += samples[start + i] ** 2;
    rms = Math.sqrt(rms / frame);
    if (rms < 0.012) continue;
    let best = 0, bestLag = 0;
    for (let lag = minLag; lag <= maxLag; lag++) {
      let s = 0;
      for (let i = 0; i < frame - lag; i += 2) s += samples[start + i] * samples[start + i + lag];
      if (s > best) { best = s; bestLag = lag; }
    }
    if (bestLag) est.push(sr / bestLag);
  }
  if (!est.length) return 0;
  est.sort((a, b) => a - b);
  return est[Math.floor(est.length / 2)];
}

/** 梅尔带对数能量 → 12 维音色向量（近似 speaker embedding） */
export function melEmbedding(samples, sr, bands = 12) {
  const fftSize = 1024;
  const frames = stft(samples, { fftSize, hop: 1024 });
  if (!frames.length) return new Array(bands).fill(0);
  const half = fftSize / 2 + 1;
  const hz = (k) => (k * sr) / fftSize;
  const mel = (f) => 2595 * Math.log10(1 + f / 700);
  const imel = (m) => 700 * (10 ** (m / 2595) - 1);
  const edges = [];
  for (let b = 0; b < bands + 2; b++) edges.push(imel(mel(70) + ((mel(7500) - mel(70)) * b) / (bands + 1)));
  const acc = new Float64Array(bands);
  for (const fr of frames) {
    const p = new Float64Array(half);
    for (let k = 0; k < half; k++) p[k] = fr[k] * fr[k];
    for (let b = 0; b < bands; b++) {
      const lo = edges[b], mid = edges[b + 1], hi = edges[b + 2];
      let e = 0;
      for (let k = 1; k < half; k++) {
        const f = hz(k);
        if (f >= lo && f <= mid) e += p[k] * ((f - lo) / Math.max(1, mid - lo));
        else if (f > mid && f <= hi) e += p[k] * ((hi - f) / Math.max(1, hi - mid));
      }
      acc[b] += Math.log10(e + 1e-9);
    }
  }
  const out = Array.from(acc, (v) => v / frames.length);
  const mean = out.reduce((a, b) => a + b, 0) / out.length;
  return out.map((v) => v - mean);
}

export function analyzeAudio(samples, sr) {
  let peak = 0, sum = 0, zc = 0;
  for (let i = 0; i < samples.length; i++) {
    const v = samples[i];
    peak = Math.max(peak, Math.abs(v));
    sum += v * v;
    if (i > 0 && (v >= 0) !== (samples[i - 1] >= 0)) zc++;
  }
  const rms = Math.sqrt(sum / Math.max(1, samples.length));
  const f0 = estimateF0(samples, sr);
  const emb = melEmbedding(samples, sr);
  // 频谱质心
  const frames = stft(samples, { fftSize: 1024, hop: 2048 });
  let cNum = 0, cDen = 0;
  for (const fr of frames) for (let k = 1; k < fr.length; k++) { const f = (k * sr) / 1024; cNum += f * fr[k]; cDen += fr[k]; }
  const centroid = cDen ? cNum / cDen : 0;
  return {
    duration: samples.length / sr,
    sampleRate: sr,
    peak, rms,
    f0: f0 || 0,
    centroid,
    zcr: zc / Math.max(1, samples.length),
    embedding: emb,
    voiced: f0 > 0,
  };
}

export function cosineSim(a, b) {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] ** 2; nb += b[i] ** 2; }
  return dot / (Math.sqrt(na) * Math.sqrt(nb) + 1e-9);
}

/* ══════════════════ 共振峰语音合成 ══════════════════ */
const VOWELS = {
  a: [730, 1090, 2440], e: [530, 1840, 2480], i: [270, 2290, 3010],
  o: [570, 840, 2410], u: [300, 870, 2240], v: [400, 1900, 2600],
  er: [490, 1350, 1690], ai: [660, 1700, 2400], ao: [570, 1000, 2400],
};
const PLOSIVES = ['p', 't', 'k', 'b', 'd', 'g'];
const FRICATIVES = ['s', 'sh', 'f', 'h', 'x', 'z', 'c'];
const NASALS = ['m', 'n', 'l', 'r', 'y', 'w'];

// 常见汉字 → 伪拼音（只为节奏与音素分布服务）
const CN_SYL = ['ni', 'hao', 'shi', 'wo', 'de', 'zhong', 'guo', 'sheng', 'yin', 'ke', 'long',
  'zao', 'ba', 'le', 'zhe', 'yi', 'duan', 'hua', 'xi', 'tong', 'zai', 'kai', 'ge', 'li',
  'yan', 'mo', 'xing', 'shu', 'ju', 'te', 'bie', 'kuai', 'man', 'da', 'xiao', 'jiao'];

function hashStr(s) { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return Math.abs(h); }

function splitLatin(word) {
  const m = word.toLowerCase().match(/[^aeiouy]*[aeiouy]+(?:[^aeiouy]*$|[^aeiouy](?=[^aeiouy]))?/g);
  return m || [word.toLowerCase()];
}

/** 文本 → 音节序列 [{onset, vowel}] */
export function textToSyllables(text) {
  const out = [];
  const tokens = String(text).match(/[\u4e00-\u9fa5]|[a-zA-Z']+|\d+|[,，。！？!?.]/g) || [];
  for (const tk of tokens) {
    if (/^[,，、]$/.test(tk)) { out.push({ pause: 0.14 }); continue; }
    if (/^[。！？!?.]$/.test(tk)) { out.push({ pause: 0.34 }); continue; }
    if (/^\d+$/.test(tk)) { out.push({ onset: 's', vowel: 'i' }); out.push({ onset: 'l', vowel: 'ai' }); continue; }
    if (/[\u4e00-\u9fa5]/.test(tk)) {
      const s = CN_SYL[hashStr(tk) % CN_SYL.length];
      const v = (s.match(/[aeiou]+/) || ['a'])[0];
      const on = s.slice(0, s.indexOf(v)) || '';
      out.push({ onset: on, vowel: v.slice(0, 2) in VOWELS ? v.slice(0, 2) : v[0] });
      continue;
    }
    for (const part of splitLatin(tk)) {
      const v = (part.match(/[aeiouy]+/) || ['a'])[0];
      const on = part.slice(0, part.indexOf(v));
      out.push({ onset: on, vowel: v.slice(0, 2) in VOWELS ? v.slice(0, 2) : v[0] });
    }
  }
  // 补一个句末停顿
  out.push({ pause: 0.22 });
  return out;
}

export function phonemize(text) {
  const syl = textToSyllables(text);
  const list = [];
  for (const s of syl) {
    if (s.pause) { list.push('·'); continue; }
    const on = s.onset ? (PLOSIVES.includes(s.onset[0]) ? s.onset[0] : FRICATIVES.includes(s.onset[0]) ? s.onset[0] : NASALS.includes(s.onset[0]) ? s.onset[0] : s.onset[0]) : '';
    list.push((on ? on + '-' : '') + s.vowel);
  }
  return list;
}

function resonatorCoeffs(freq, bw, sr) {
  const r = Math.exp((-Math.PI * bw) / sr);
  const b = 2 * r * Math.cos((2 * Math.PI * freq) / sr);
  const c = -r * r;
  const a = 1 - b - c;
  return { a, b, c };
}

/**
 * 合成语音
 * @param {object} o {text, speaker, speed, expr, pitchShift, quality}
 *   speaker: {f0, formantScale, breath, brightness}
 */
export function synthesizeSpeech(o) {
  const {
    text, speed = 1, expr = 0.6, pitchShift = 0, quality = 1,
    speaker = { f0: 128, formantScale: 1, breath: 0.3, brightness: 0.5 },
  } = o || {};
  const syl = textToSyllables(text);
  const sr = SR;
  const f0base = clamp(speaker.f0 * Math.pow(2, pitchShift / 12), 60, 420);
  const fscale = speaker.formantScale || 1;
  const breath = clamp(speaker.breath ?? 0.3, 0, 1);
  const exprAmt = clamp(expr, 0, 1);

  // ── 构建时间段 ──
  const segs = [];
  let t = 0;
  const question = /[?？]$/.test(text.trim());
  for (const s of syl) {
    if (s.pause != null) { segs.push({ kind: 'pause', dur: s.pause / speed }); t += s.pause / speed; continue; }
    const on = s.onset || '';
    const vowelDur = (0.135 + 0.045 * (s.vowel.length > 1 ? 1 : 0)) / speed;
    if (on) {
      const c = on[0];
      if (PLOSIVES.includes(c)) {
        const d = 0.045 / speed;
        segs.push({ kind: 'burst', dur: d, vowel: s.vowel, c });
        t += d;
      } else if (FRICATIVES.includes(c)) {
        const d = 0.075 / speed;
        segs.push({ kind: 'noise', dur: d, vowel: s.vowel, c });
        t += d;
      } else {
        const d = 0.042 / speed;
        segs.push({ kind: 'nasal', dur: d, vowel: s.vowel, c });
        t += d;
      }
    }
    segs.push({ kind: 'vowel', dur: vowelDur, vowel: s.vowel, acc: (Math.random() - 0.5) * exprAmt });
    t += vowelDur;
  }
  if (!segs.length) return { samples: new Float32Array(0), sr, segs: [] };

  const total = Math.ceil(t * sr) + Math.floor(sr * 0.05);
  const out = new Float32Array(total);

  // ── 声门源 + 共振峰 ──
  let phase = 0;
  const res = [{ y1: 0, y2: 0 }, { y1: 0, y2: 0 }, { y1: 0, y2: 0 }, { y1: 0, y2: 0 }];
  let co = [{ a: 1, b: 0, c: 0 }, { a: 1, b: 0, c: 0 }, { a: 1, b: 0, c: 0 }, { a: 1, b: 0, c: 0 }];
  let curF = [500, 1500, 2500, 3500];
  let targetF = [500, 1500, 2500, 3500];
  const noiseAmpState = { v: 0 };

  // 段落起点表
  const bounds = [];
  let acc = 0;
  for (const s of segs) { bounds.push({ start: acc, end: acc + s.dur, seg: s }); acc += s.dur; }

  let si = 0;
  const rnd = (() => { let seed = hashStr(text) || 12345; return () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; }; })();

  for (let i = 0; i < total; i++) {
    const tt = i / sr;
    while (si < bounds.length - 1 && tt > bounds[si].end) si++;
    const b = bounds[si];
    const seg = b.seg;
    const segDur = Math.max(1e-6, b.end - b.start);
    const local = (tt - b.start) / segDur;
    const envSeg = Math.min(1, local / 0.18) * Math.min(1, (1 - local) / 0.22);

    // 目标共振峰
    if (seg.kind === 'vowel' || seg.kind === 'burst' || seg.kind === 'noise' || seg.kind === 'nasal') {
      const v = VOWELS[seg.vowel] || VOWELS.a;
      targetF = [v[0] * fscale, v[1] * fscale, v[2] * fscale, 3500 * fscale];
    } else {
      targetF = [420, 1350, 2500, 3500];
    }
    for (let k = 0; k < 4; k++) curF[k] += (targetF[k] - curF[k]) * 0.012;

    // 基频轨迹：整体下倾 + 音节重音 + 疑问句上扬 + 抖动
    const posInSent = tt / (total / sr);
    let f0 = f0base * (1.06 - 0.16 * posInSent);
    const accent = seg.acc || 0;
    f0 *= 1 + accent * 0.16;
    if (question) f0 *= 1 + 0.22 * Math.max(0, posInSent - 0.65);
    f0 *= 1 + 0.012 * Math.sin(tt * 2 * Math.PI * 4.6); // vibrato-ish
    f0 *= 1 + 0.004 * (rnd() - 0.5);                    // jitter
    if (seg.kind === 'pause') f0 = f0base;
    phase += f0 / sr;
    if (phase >= 1) phase -= 1;

    // 声门脉冲（Rosenberg 近似）+ 气声
    let src = 0;
    let voicedGain = 0;
    if (seg.kind === 'vowel') voicedGain = 0.95 * envSeg;
    else if (seg.kind === 'nasal') voicedGain = 0.55 * envSeg;
    else if (seg.kind === 'burst') voicedGain = 0.2;
    else voicedGain = 0;

    if (voicedGain > 0) {
      // 脉冲形状：短促上升 + 快速下降
      const p = phase;
      const pulse = p < 0.4 ? Math.sin((p / 0.4) * Math.PI) ** 2 : 0;
      src += pulse * 1.0;
    }
    // 噪声源
    let nAmp = 0;
    if (seg.kind === 'noise') nAmp = 0.55 * envSeg;
    else if (seg.kind === 'burst') nAmp = 0.5 * Math.max(0, 1 - local * 1.4);
    else if (seg.kind === 'vowel') nAmp = breath * 0.14 * envSeg;
    const nz = nAmp > 0 ? (rnd() * 2 - 1) * nAmp : 0;

    // 每 32 样本更新系数
    if (i % 32 === 0) {
      const srcF = seg.kind === 'noise' || seg.kind === 'burst'
        ? [1800 * fscale, 3200 * fscale, 5200, 6800]
        : curF;
      co = [
        resonatorCoeffs(srcF[0], 80, sr),
        resonatorCoeffs(srcF[1], 100, sr),
        resonatorCoeffs(srcF[2], 140, sr),
        resonatorCoeffs(Math.min(srcF[3], sr * 0.45), 260, sr),
      ];
    }

    // 级联滤波
    let y = src * voicedGain + nz;
    for (let k = 0; k < 4; k++) {
      const { a, b, c } = co[k];
      const yn = a * y + b * res[k].y1 + c * res[k].y2;
      res[k].y2 = res[k].y1; res[k].y1 = yn;
      y = yn;
    }
    // 高频倾斜（brightness 控制）
    const bright = 0.35 + 0.65 * (speaker.brightness ?? 0.5);
    noiseAmpState.v += (y - noiseAmpState.v) * (0.05 + 0.28 * bright);
    const tilt = 0.45 + 0.55 * bright;
    out[i] = (y * 0.55 + noiseAmpState.v * (1 - tilt)) * 0.55;
  }

  // 去直流 + 归一化 + 首尾淡入淡出
  let mean = 0;
  for (let i = 0; i < total; i++) mean += out[i];
  mean /= total;
  let peak = 0;
  for (let i = 0; i < total; i++) { out[i] -= mean; peak = Math.max(peak, Math.abs(out[i])); }
  const g = peak > 0 ? 0.92 / peak : 1;
  const fade = Math.floor(sr * 0.012);
  for (let i = 0; i < total; i++) {
    let v = out[i] * g * quality;
    if (i < fade) v *= i / fade;
    if (i > total - fade) v *= (total - i) / fade;
    out[i] = v;
  }
  return { samples: out, sr, segs: bounds };
}

/* ══════════════════ 播放 ══════════════════ */
let ctx = null;
let current = null;
export function getCtx() {
  if (!ctx) ctx = new (window.AudioContext || window.webkitAudioContext)();
  if (ctx.state === 'suspended') ctx.resume();
  return ctx;
}
export function play(samples, sr = SR, onEnd) {
  stop();
  const c = getCtx();
  const buf = c.createBuffer(1, samples.length, sr);
  buf.copyToChannel(samples instanceof Float32Array ? samples : Float32Array.from(samples), 0);
  const src = c.createBufferSource();
  src.buffer = buf;
  const gain = c.createGain();
  gain.gain.value = 0.9;
  src.connect(gain).connect(c.destination);
  src.onended = () => { current = null; onEnd && onEnd(); };
  src.start();
  current = src;
  return { stop };
}
export function stop() {
  if (current) { try { current.stop(); } catch (e) {} current = null; }
}

/* ══════════════════ 导出 wav ══════════════════ */
export function toWavBlob(samples, sr = SR) {
  const n = samples.length;
  const buf = new ArrayBuffer(44 + n * 2);
  const v = new DataView(buf);
  const w = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  w(0, 'RIFF'); v.setUint32(4, 36 + n * 2, true); w(8, 'WAVE');
  w(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, sr, true); v.setUint32(28, sr * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
  w(36, 'data'); v.setUint32(40, n * 2, true);
  let o = 44;
  for (let i = 0; i < n; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    v.setInt16(o, s < 0 ? s * 0x8000 : s * 0x7fff, true);
    o += 2;
  }
  return new Blob([buf], { type: 'audio/wav' });
}

/* ══════════════════ 绘制 ══════════════════ */
function setupCanvas(canvas) {
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const rect = canvas.getBoundingClientRect();
  const w = Math.max(60, Math.floor(rect.width || canvas.clientWidth || 600));
  const h = Math.max(20, Math.floor(rect.height || canvas.clientHeight || 100));
  canvas.width = Math.floor(w * dpr);
  canvas.height = Math.floor(h * dpr);
  const g = canvas.getContext('2d');
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  return { g, w, h };
}

export function drawWaveform(canvas, samples, opts = {}) {
  if (!canvas || !samples) return;
  const { g, w, h } = setupCanvas(canvas);
  const mid = h / 2;
  g.clearRect(0, 0, w, h);
  // 网格
  g.strokeStyle = 'rgba(32,190,255,.07)';
  g.lineWidth = 1;
  for (let x = 0; x <= w; x += 40) { g.beginPath(); g.moveTo(x, 0); g.lineTo(x, h); g.stroke(); }
  g.strokeStyle = 'rgba(120,150,190,.16)';
  g.beginPath(); g.moveTo(0, mid); g.lineTo(w, mid); g.stroke();

  const step = Math.max(1, Math.floor(samples.length / (w * 1.5)));
  const grad = g.createLinearGradient(0, 0, 0, h);
  grad.addColorStop(0, opts.color || '#20beff');
  grad.addColorStop(0.5, opts.color2 || '#7ddcff');
  grad.addColorStop(1, opts.color || '#20beff');
  g.fillStyle = grad;
  const bars = Math.floor(w);
  for (let x = 0; x < bars; x++) {
    const i0 = Math.floor((x / bars) * samples.length);
    const i1 = Math.min(samples.length, Math.floor(((x + 1) / bars) * samples.length));
    let mx = 0;
    for (let i = i0; i < i1; i += step) mx = Math.max(mx, Math.abs(samples[i]));
    const bh = Math.max(0.6, mx * (h / 2 - 3));
    g.globalAlpha = 0.28;
    g.fillRect(x, mid - bh, 0.9, bh * 2);
    g.globalAlpha = 0.95;
    g.fillRect(x, mid - bh * 0.62, 0.9, bh * 1.24);
  }
  g.globalAlpha = 1;
  if (opts.playhead != null) {
    const px = opts.playhead * w;
    g.strokeStyle = '#ffb020';
    g.lineWidth = 1.5;
    g.beginPath(); g.moveTo(px, 0); g.lineTo(px, h); g.stroke();
  }
}

const COLORMAP = (() => {
  // 近似 magma
  const stops = [
    [0, [4, 5, 14]], [0.22, [40, 24, 88]], [0.45, [129, 47, 121]],
    [0.68, [213, 82, 96]], [0.85, [249, 152, 74]], [1, [252, 253, 191]],
  ];
  return (v) => {
    for (let i = 1; i < stops.length; i++) {
      if (v <= stops[i][0]) {
        const [p0, c0] = stops[i - 1], [p1, c1] = stops[i];
        const f = (v - p0) / (p1 - p0 || 1);
        return [c0[0] + (c1[0] - c0[0]) * f, c0[1] + (c1[1] - c0[1]) * f, c0[2] + (c1[2] - c0[2]) * f];
      }
    }
    return stops[stops.length - 1][1];
  };
})();

export function drawSpectrogram(canvas, samples, sr = SR, opts = {}) {
  if (!canvas || !samples || !samples.length) return;
  const { g, w, h } = setupCanvas(canvas);
  const fftSize = 512, hop = Math.max(128, Math.ceil(samples.length / (w * 1.2)));
  const frames = stft(samples, { fftSize, hop });
  if (!frames.length) return;
  const bins = frames[0].length;
  const maxF = Math.min(sr / 2, opts.maxFreq || 8000);
  const keep = Math.max(8, Math.floor((maxF / (sr / 2)) * bins));

  const off = document.createElement('canvas');
  off.width = frames.length;
  off.height = keep;
  const og = off.getContext('2d');
  const img = og.createImageData(frames.length, keep);
  let maxDb = -200;
  const db = frames.map((fr) => Array.from(fr.slice(0, keep), (v) => 20 * Math.log10(v + 1e-9)));
  for (const row of db) for (const v of row) maxDb = Math.max(maxDb, v);
  const floor = maxDb - 62;
  for (let x = 0; x < frames.length; x++) {
    for (let y = 0; y < keep; y++) {
      const v = Math.max(0, Math.min(1, (db[x][y] - floor) / 62));
      const [r, gg, b] = COLORMAP(Math.pow(v, 1.25));
      const idx = ((keep - 1 - y) * frames.length + x) * 4;
      img.data[idx] = r; img.data[idx + 1] = gg; img.data[idx + 2] = b; img.data[idx + 3] = 255;
    }
  }
  og.putImageData(img, 0, 0);
  g.clearRect(0, 0, w, h);
  g.imageSmoothingEnabled = true;
  g.drawImage(off, 0, 0, frames.length, keep, 0, 0, w, h);

  // 频率刻度
  g.fillStyle = 'rgba(8,12,20,.62)';
  g.fillRect(0, 0, 44, h);
  g.font = '9px ui-monospace, monospace';
  g.fillStyle = 'rgba(220,235,250,.72)';
  for (let f = 0; f <= maxF; f += 2000) {
    const y = h - (f / maxF) * h;
    g.fillText(f >= 1000 ? `${f / 1000}k` : `${f}`, 4, Math.min(h - 3, Math.max(9, y - 2)));
    g.fillStyle = 'rgba(220,235,250,.1)';
    g.fillRect(0, y, w, 0.5);
    g.fillStyle = 'rgba(220,235,250,.72)';
  }
}
