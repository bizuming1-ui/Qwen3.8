/** util.js — 小工具 */
export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

export function el(tag, props = {}, children = []) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'class') node.className = v;
    else if (k === 'html') node.innerHTML = v;
    else if (k === 'text') node.textContent = v;
    else if (k === 'style' && typeof v === 'object') Object.assign(node.style, v);
    else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2).toLowerCase(), v);
    else if (v !== null && v !== undefined && v !== false) node.setAttribute(k, v);
  }
  for (const c of [].concat(children)) {
    if (c == null) continue;
    node.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
  }
  return node;
}

export const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const fmt = (n, d = 2) => Number(n).toFixed(d);
export const pad = (n) => String(n).padStart(2, '0');

export function fmtClock(sec) {
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = Math.floor(sec % 60);
  return `${pad(h)}:${pad(m)}:${pad(s)}`;
}

export function fmtBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 ** 2).toFixed(1)} MB`;
}

/** 确定性随机（mulberry32） */
export function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function gauss(r) {
  let u = 0, v = 0;
  while (u === 0) u = r();
  while (v === 0) v = r();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

export function toast(msg, kind = '') {
  const host = document.getElementById('toasts');
  if (!host) return;
  const t = el('div', { class: `toast ${kind}`, text: msg });
  host.appendChild(t);
  setTimeout(() => {
    t.style.transition = 'opacity .3s, transform .3s';
    t.style.opacity = '0';
    t.style.transform = 'translateX(16px)';
    setTimeout(() => t.remove(), 320);
  }, 3200);
}

export function downloadBlob(blob, name) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
}

/** 简单 Python 语法高亮 */
const PY_KW = new Set(['import', 'from', 'as', 'def', 'return', 'for', 'in', 'while', 'if', 'elif', 'else', 'try', 'except', 'finally', 'with', 'class', 'and', 'or', 'not', 'is', 'None', 'True', 'False', 'lambda', 'yield', 'global', 'assert', 'pass', 'raise', 'break', 'continue', 'self', 'print', 'await', 'async']);
const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export function highlightPython(src) {
  let out = '';
  let i = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i];
    // 行首 magic
    if ((c === '!' || c === '%') && (i === 0 || src[i - 1] === '\n')) {
      let j = i;
      while (j < n && src[j] !== '\n') j++;
      out += `<span class="tk-magic">${esc(src.slice(i, j))}</span>`;
      i = j;
      continue;
    }
    if (c === '#') {
      let j = i;
      while (j < n && src[j] !== '\n') j++;
      out += `<span class="tk-com">${esc(src.slice(i, j))}</span>`;
      i = j;
      continue;
    }
    if (c === '"' || c === "'") {
      const triple = src.slice(i, i + 3) === c.repeat(3);
      const q = triple ? c.repeat(3) : c;
      let j = i + q.length;
      while (j < n) {
        if (src[j] === '\\') { j += 2; continue; }
        if (src.slice(j, j + q.length) === q) { j += q.length; break; }
        if (!triple && src[j] === '\n') break;
        j++;
      }
      out += `<span class="tk-str">${esc(src.slice(i, j))}</span>`;
      i = j;
      continue;
    }
    if (/[0-9]/.test(c) && !/[A-Za-z_]/.test(src[i - 1] || '')) {
      let j = i;
      while (j < n && /[0-9._eExXa-fA-F]/.test(src[j])) j++;
      out += `<span class="tk-num">${esc(src.slice(i, j))}</span>`;
      i = j;
      continue;
    }
    if (/[A-Za-z_]/.test(c)) {
      let j = i;
      while (j < n && /[A-Za-z0-9_]/.test(src[j])) j++;
      const w = src.slice(i, j);
      if (PY_KW.has(w)) out += `<span class="tk-kw">${esc(w)}</span>`;
      else if (src[j] === '(') out += `<span class="tk-fn">${esc(w)}</span>`;
      else out += esc(w);
      i = j;
      continue;
    }
    out += esc(c);
    i++;
  }
  return out;
}
