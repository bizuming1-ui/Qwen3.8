/** charts.js — canvas 绘图：折线 / 波形(带坐标轴) / 雷达 / 柱状 / 迷你走势 */

function setup(canvas, cssH) {
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const rect = canvas.getBoundingClientRect();
  const w = Math.max(80, Math.floor(rect.width || 600));
  const h = Math.max(40, Math.floor(cssH || rect.height || 160));
  canvas.style.height = h + 'px';
  canvas.width = Math.floor(w * dpr);
  canvas.height = Math.floor(h * dpr);
  const g = canvas.getContext('2d');
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, w, h);
  return { g, w, h };
}

const FONT = '10px ui-monospace, SFMono-Regular, Menlo, monospace';

export function lineChart(canvas, opts = {}) {
  const {
    series = [], xLabel = '', yLabel = '', title = '',
    yMin = null, yMax = null, xMax = null, grid = true, smooth = true,
    markers = false, bg = 'rgba(7,12,21,0)',
  } = opts;
  const { g, w, h } = setup(canvas, opts.height);
  const pl = 42, pr = 12, pt = title ? 26 : 12, pb = 28;
  const iw = w - pl - pr, ih = h - pt - pb;

  if (bg !== 'none') { g.fillStyle = bg; g.fillRect(0, 0, w, h); }

  const all = series.flatMap((s) => s.data);
  let lo = yMin, hi = yMax;
  if (lo == null) lo = Math.min(...all);
  if (hi == null) hi = Math.max(...all);
  if (!isFinite(lo)) { lo = 0; hi = 1; }
  if (hi === lo) { hi = lo + 1; }
  const padY = (hi - lo) * 0.12;
  lo -= padY; hi += padY;
  const n = Math.max(2, ...series.map((s) => s.data.length));
  const xMaxV = xMax ?? n - 1;

  const X = (i) => pl + (i / Math.max(1, xMaxV)) * iw;
  const Y = (v) => pt + ih - ((v - lo) / (hi - lo)) * ih;

  // 网格 + y 轴刻度
  g.strokeStyle = 'rgba(120,150,190,.09)';
  g.lineWidth = 1;
  g.font = FONT;
  g.fillStyle = 'rgba(140,160,185,.75)';
  for (let i = 0; i <= 4; i++) {
    const y = pt + (ih * i) / 4;
    if (grid) { g.beginPath(); g.moveTo(pl, y); g.lineTo(w - pr, y); g.stroke(); }
    const val = hi - ((hi - lo) * i) / 4;
    g.textAlign = 'right';
    g.fillText(Math.abs(val) >= 100 ? val.toFixed(0) : val.toFixed(Math.abs(val) < 1 ? 3 : 2), pl - 6, y + 3);
  }
  for (let i = 0; i <= 5; i++) {
    const x = pl + (iw * i) / 5;
    if (grid) { g.beginPath(); g.moveTo(x, pt); g.lineTo(x, pt + ih); g.stroke(); }
    g.textAlign = 'center';
    g.fillText(Math.round((xMaxV * i) / 5), x, h - 9);
  }
  g.strokeStyle = 'rgba(120,150,190,.28)';
  g.beginPath(); g.moveTo(pl, pt); g.lineTo(pl, pt + ih); g.lineTo(w - pr, pt + ih); g.stroke();

  // 曲线
  for (const s of series) {
    if (!s.data.length) continue;
    g.strokeStyle = s.color || '#20beff';
    g.lineWidth = s.width || 1.8;
    g.setLineDash(s.dashed ? [4, 3] : []);
    g.beginPath();
    s.data.forEach((v, i) => {
      const x = X(i), y = Y(v);
      if (i === 0) g.moveTo(x, y);
      else if (smooth && i >= 1) {
        const px = X(i - 1), py = Y(s.data[i - 1]);
        g.quadraticCurveTo(px, py, (px + x) / 2, (py + y) / 2);
        if (i === s.data.length - 1) g.lineTo(x, y);
      } else g.lineTo(x, y);
    });
    g.stroke();
    g.setLineDash([]);
    if (s.fill) {
      g.lineTo(X(s.data.length - 1), pt + ih);
      g.lineTo(X(0), pt + ih);
      g.closePath();
      const grad = g.createLinearGradient(0, pt, 0, pt + ih);
      grad.addColorStop(0, (s.color || '#20beff') + '44');
      grad.addColorStop(1, (s.color || '#20beff') + '00');
      g.fillStyle = grad;
      g.fill();
    }
    if (markers) {
      const last = s.data.length - 1;
      g.fillStyle = s.color || '#20beff';
      g.beginPath(); g.arc(X(last), Y(s.data[last]), 2.6, 0, Math.PI * 2); g.fill();
    }
  }

  // 标题 / 轴标签
  if (title) {
    g.fillStyle = 'rgba(230,240,252,.9)';
    g.textAlign = 'left';
    g.font = '11px ui-sans-serif, system-ui, sans-serif';
    g.fillText(title, pl, 15);
  }
  g.font = FONT;
  g.fillStyle = 'rgba(140,160,185,.75)';
  if (xLabel) { g.textAlign = 'center'; g.fillText(xLabel, pl + iw / 2, h - 1); }
  if (yLabel) {
    g.save(); g.translate(10, pt + ih / 2); g.rotate(-Math.PI / 2);
    g.textAlign = 'center'; g.fillText(yLabel, 0, 0); g.restore();
  }
  // 图例
  if (series.length > 1) {
    let lx = w - pr - 4;
    g.textAlign = 'right';
    for (let i = series.length - 1; i >= 0; i--) {
      const s = series[i];
      if (!s.label) continue;
      g.fillStyle = 'rgba(200,215,235,.85)';
      g.fillText(s.label, lx, pt + 10);
      const tw = g.measureText(s.label).width;
      lx -= tw + 20;
      g.fillStyle = s.color;
      g.fillRect(lx, pt + 5, 12, 2.5);
      lx -= 8;
    }
  }
}

export function waveChart(canvas, samples, sr, opts = {}) {
  const { g, w, h } = setup(canvas, opts.height || 130);
  const pl = 42, pr = 10, pt = opts.title ? 24 : 10, pb = 24;
  const iw = w - pl - pr, ih = h - pt - pb;
  g.strokeStyle = 'rgba(120,150,190,.09)';
  g.font = '10px ui-monospace, monospace';
  g.fillStyle = 'rgba(140,160,185,.7)';
  for (let i = 0; i <= 2; i++) {
    const y = pt + (ih * i) / 2;
    g.beginPath(); g.moveTo(pl, y); g.lineTo(w - pr, y); g.stroke();
    g.textAlign = 'right';
    g.fillText((1 - i).toFixed(1), pl - 6, y + 3);
  }
  const dur = samples.length / sr;
  for (let i = 0; i <= 4; i++) {
    const x = pl + (iw * i) / 4;
    g.textAlign = 'center';
    g.fillText(((dur * i) / 4).toFixed(2), x, h - 8);
    g.beginPath(); g.moveTo(x, pt); g.lineTo(x, pt + ih); g.stroke();
  }
  g.strokeStyle = 'rgba(120,150,190,.3)';
  g.beginPath(); g.moveTo(pl, pt + ih / 2); g.lineTo(w - pr, pt + ih / 2); g.stroke();

  g.strokeStyle = opts.color || '#1f9bd6';
  g.lineWidth = 1;
  g.beginPath();
  const step = Math.max(1, Math.floor(samples.length / (iw * 2)));
  for (let x = 0; x < iw; x++) {
    const i0 = Math.floor((x / iw) * samples.length);
    let mx = 0;
    for (let i = i0; i < Math.min(samples.length, i0 + step * 2); i++) mx = Math.max(mx, Math.abs(samples[i]));
    const bh = mx * (ih / 2);
    g.moveTo(pl + x, pt + ih / 2 - bh);
    g.lineTo(pl + x, pt + ih / 2 + bh + 0.4);
  }
  g.stroke();

  if (opts.title) {
    g.fillStyle = 'rgba(230,240,252,.9)';
    g.textAlign = 'left';
    g.font = '11px ui-sans-serif, system-ui, sans-serif';
    g.fillText(opts.title, pl, 14);
  }
  g.font = '10px ui-monospace, monospace';
  g.fillStyle = 'rgba(140,160,185,.7)';
  g.textAlign = 'center';
  g.fillText('Time (s)', pl + iw / 2, h - 1);
}

export function radar(canvas, values, opts = {}) {
  const { g, w, h } = setup(canvas, opts.height || 132);
  const cx = w / 2, cy = h / 2, R = Math.min(w, h) / 2 - 12;
  const n = values.length;
  const maxAbs = Math.max(0.001, ...values.map((v) => Math.abs(v)));
  g.strokeStyle = 'rgba(120,150,190,.16)';
  for (let ring = 1; ring <= 3; ring++) {
    g.beginPath();
    for (let i = 0; i <= n; i++) {
      const a = (i / n) * Math.PI * 2 - Math.PI / 2;
      const r = (R * ring) / 3;
      const x = cx + Math.cos(a) * r, y = cy + Math.sin(a) * r;
      i === 0 ? g.moveTo(x, y) : g.lineTo(x, y);
    }
    g.closePath(); g.stroke();
  }
  g.beginPath();
  values.forEach((v, i) => {
    const a = (i / n) * Math.PI * 2 - Math.PI / 2;
    const r = (Math.abs(v) / maxAbs) * R;
    const x = cx + Math.cos(a) * r, y = cy + Math.sin(a) * r;
    i === 0 ? g.moveTo(x, y) : g.lineTo(x, y);
  });
  g.closePath();
  const col = opts.color || '#20beff';
  const grad = g.createRadialGradient(cx, cy, 2, cx, cy, R);
  grad.addColorStop(0, col + 'aa');
  grad.addColorStop(1, col + '22');
  g.fillStyle = grad;
  g.fill();
  g.strokeStyle = col;
  g.lineWidth = 1.4;
  g.stroke();
  values.forEach((v, i) => {
    const a = (i / n) * Math.PI * 2 - Math.PI / 2;
    const r = (Math.abs(v) / maxAbs) * R;
    g.fillStyle = col;
    g.beginPath(); g.arc(cx + Math.cos(a) * r, cy + Math.sin(a) * r, 1.8, 0, Math.PI * 2); g.fill();
  });
}

export function sparkline(canvas, values, opts = {}) {
  const { g, w, h } = setup(canvas, opts.height || 34);
  const min = Math.min(...values), max = Math.max(...values);
  const span = max - min || 1;
  g.strokeStyle = opts.color || '#20beff';
  g.lineWidth = 1.4;
  g.beginPath();
  values.forEach((v, i) => {
    const x = (i / Math.max(1, values.length - 1)) * (w - 4) + 2;
    const y = h - 3 - ((v - min) / span) * (h - 6);
    i === 0 ? g.moveTo(x, y) : g.lineTo(x, y);
  });
  g.stroke();
}

export function bars(canvas, values, opts = {}) {
  const { g, w, h } = setup(canvas, opts.height || 90);
  const max = Math.max(1e-6, ...values);
  const bw = w / values.length;
  values.forEach((v, i) => {
    const bh = (v / max) * (h - 12);
    const grad = g.createLinearGradient(0, h - bh, 0, h);
    grad.addColorStop(0, opts.color || '#20beff');
    grad.addColorStop(1, (opts.color || '#20beff') + '33');
    g.fillStyle = grad;
    g.fillRect(i * bw + bw * 0.15, h - bh, bw * 0.7, bh);
  });
}
