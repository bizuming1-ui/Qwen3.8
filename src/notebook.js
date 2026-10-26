/** notebook.js — Notebook 渲染与执行 */
import { el, highlightPython, fmt, toast, downloadBlob } from './util.js';
import { drawWaveform, play, stop, toWavBlob } from './audio.js';


const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

let uid = 0;

export class Notebook {
  constructor(app, host) {
    this.app = app;
    this.host = host;
    this.kernel = app.kernel;
    this.execCounter = 0;
    this.busy = false;
    this.queue = Promise.resolve();
  }

  render() {
    this.host.innerHTML = '';
    this.app.state.cells.forEach((cell, i) => this.host.appendChild(this.cellNode(cell, i)));
    this.updateMeta();
  }

  updateMeta() {
    const cells = this.app.state.cells;
    const n = cells.length;
    const nb = document.getElementById('nbCellCount');
    if (nb) nb.textContent = n;
  }

  /* ══════ 单元格节点 ══════ */
  cellNode(cell, index) {
    if (!cell.id) cell.id = 'c' + ++uid;
    const node = el('div', { class: 'cell', 'data-id': cell.id });
    node.dataset.index = index;

    // gutter
    const gutter = el('div', { class: 'cell-gutter' }, [
      el('span', { class: 'exec-count', text: cell.type === 'code' ? (cell.count || '') : '' }),
      cell.type === 'code'
        ? el('button', { class: 'run-btn', title: 'Run (Shift+Enter)', text: '▶', onclick: () => this.runCell(cell) })
        : el('span', { class: 'exec-count', text: '' }),
    ]);

    const main = el('div', { class: 'cell-main' });

    if (cell.type === 'md') {
      const body = el('div', { class: 'md-cell', html: mdToHtml(cell.source) });
      body.addEventListener('dblclick', () => this.editMarkdown(cell, node, body));
      main.appendChild(body);
      main.appendChild(this.toolbar(cell, index, true));
    } else {
      const wrap = el('div', { class: 'editor-wrap' });
      const pre = el('pre', { 'aria-hidden': 'true', html: highlightPython(cell.source) });
      const ta = el('textarea', { spellcheck: 'false', rows: '1' });
      ta.value = cell.source;
      ta.style.height = 'auto';
      wrap.appendChild(pre);
      wrap.appendChild(ta);

      const resize = () => {
        ta.style.height = 'auto';
        ta.style.height = Math.max(28, ta.scrollHeight) + 'px';
        pre.style.height = ta.style.height;
      };
      const sync = () => {
        pre.innerHTML = highlightPython(ta.value) + '\n';
        pre.scrollTop = ta.scrollTop;
        pre.scrollLeft = ta.scrollLeft;
        this.app.markDirty();
      };
      ta.addEventListener('input', () => { cell.source = ta.value; resize(); sync(); });
      ta.addEventListener('scroll', () => { pre.scrollTop = ta.scrollTop; pre.scrollLeft = ta.scrollLeft; });
      ta.addEventListener('keydown', (e) => {
        if (e.key === 'Tab') {
          e.preventDefault();
          const s = ta.selectionStart, en = ta.selectionEnd;
          ta.value = ta.value.slice(0, s) + '    ' + ta.value.slice(en);
          ta.selectionStart = ta.selectionEnd = s + 4;
          cell.source = ta.value; resize(); sync();
        }
        if (e.key === 'Enter' && (e.shiftKey)) { e.preventDefault(); this.runCell(cell); }
        if (e.key === 'Enter' && e.ctrlKey) { e.preventDefault(); this.runCell(cell); }
      });
      ta.addEventListener('focus', () => {
        this.host.querySelectorAll('.cell.is-selected').forEach((n) => n.classList.remove('is-selected'));
        node.classList.add('is-selected');
      });
      requestAnimationFrame(resize);

      main.appendChild(this.toolbar(cell, index, true));
      main.appendChild(wrap);
      const outs = el('div', { class: 'outputs' });
      main.appendChild(outs);
      cell._node = node;
      cell._outs = outs;
    }

    node.appendChild(gutter);
    node.appendChild(main);
    return node;
  }

  toolbar(cell, index, withRun) {
    return el('div', { class: 'cell-toolbar' }, [
      el('span', { class: 'cell-kind', text: cell.type === 'md' ? 'Markdown' : 'Python' }),
      el('span', { class: 'cell-time', text: cell.tookMs ? `${fmt(cell.tookMs / 1000, 2)}s` : '' }),
      el('div', { class: 'cell-actions' }, [
        withRun ? el('button', { class: 'icon-btn', title: '运行', text: '▶ run', onclick: () => this.runCell(cell) }) : null,
        el('button', { class: 'icon-btn', title: '复制源码', text: '⧉', onclick: () => { navigator.clipboard?.writeText(cell.source); toast('已复制源码'); } }),
        el('button', { class: 'icon-btn', title: '向上移动', text: '↑', onclick: () => this.move(cell, -1) }),
        el('button', { class: 'icon-btn', title: '向下移动', text: '↓', onclick: () => this.move(cell, 1) }),
        el('button', { class: 'icon-btn', title: '删除', text: '✕', onclick: () => this.remove(cell) }),
      ]),
    ]);
  }

  editMarkdown(cell, node, body) {
    const ta = el('textarea', { class: 'text-input', rows: '4' });
    ta.value = cell.source;
    ta.style.fontFamily = 'var(--mono)';
    ta.style.fontSize = '12.5px';
    body.replaceWith(el('div', { class: 'md-cell md-edit' }, [ta]));
    ta.focus();
    const commit = () => {
      cell.source = ta.value;
      const holder = ta.closest('.md-cell');
      holder.className = 'md-cell';
      holder.innerHTML = mdToHtml(cell.source);
      holder.addEventListener('dblclick', () => this.editMarkdown(cell, node, holder));
      this.app.markDirty();
    };
    ta.addEventListener('blur', commit);
    ta.addEventListener('keydown', (e) => { if (e.key === 'Escape') ta.blur(); });
  }

  move(cell, dir) {
    const cells = this.app.state.cells;
    const i = cells.indexOf(cell);
    const j = i + dir;
    if (j < 0 || j >= cells.length) return;
    [cells[i], cells[j]] = [cells[j], cells[i]];
    this.render();
    this.app.markDirty();
  }

  remove(cell) {
    const cells = this.app.state.cells;
    const i = cells.indexOf(cell);
    if (i >= 0) cells.splice(i, 1);
    this.render();
    this.app.markDirty();
  }

  addCell(type) {
    const cell = { type, source: type === 'code' ? '' : '### 新标题', id: 'c' + ++uid, outputs: [] };
    this.app.state.cells.push(cell);
    this.render();
    const node = this.host.querySelector(`[data-id="${cell.id}"]`);
    node?.scrollIntoView({ block: 'center', behavior: 'smooth' });
    node?.querySelector('textarea')?.focus();
    this.app.markDirty();
  }

  /* ══════ 执行 ══════ */
  async runCell(cell) {
    if (cell.type !== 'code' || this.busy) return;
    this.queue = this.queue.then(() => this._run(cell));
    return this.queue;
  }

  async _run(cell) {
    if (this.busy) return;
    this.busy = true;
    const node = cell._node || this.host.querySelector(`[data-id="${cell.id}"]`);
    const outs = cell._outs || node?.querySelector('.outputs');
    if (!node || !outs) { this.busy = false; return; }

    node.classList.add('is-running');
    const countEl = node.querySelector('.exec-count');
    countEl.classList.add('busy');
    countEl.textContent = '[*]';
    outs.innerHTML = '';
    const t0 = performance.now();
    this.app.setKernelBusy(true, 'Running cell…');

    let block = null;
    let blockLines = [];
    let lastCls = null;

    const flushBlock = () => {
      // 已在 DOM 中，无需额外处理
      block = null; blockLines = []; lastCls = null;
    };
    const pushLine = (text, cls, cr) => {
      if (!block || lastCls !== cls) {
        if (block && lastCls !== cls) flushBlock();
      }
      if (!block) {
        block = el('div', { class: 'out-block' });
        outs.appendChild(block);
        blockLines = [];
        lastCls = cls;
      }
      const parts = String(text).split('\n');
      for (let i = 0; i < parts.length; i++) {
        const isLast = i === parts.length - 1;
        if (i > 0 || !cr) {
          if (isLast && parts[i] === '') continue;
          blockLines.push({ t: parts[i], c: cls });
        } else {
          // cr：覆盖最后一行
          if (blockLines.length) blockLines[blockLines.length - 1] = { t: parts[i], c: cls };
          else blockLines.push({ t: parts[i], c: cls });
        }
      }
      block.innerHTML = blockLines.map((l) => `<span class="ln ${l.c || ''}">${esc(l.t)}</span>`).join('');
      outs.scrollIntoView({ block: 'nearest' });
    };

    const figs = new Map();
    let failed = false;

    try {
      for await (const ev of this.kernel.run(cell.source, {})) {
        switch (ev.type) {
          case 'stream':
            pushLine(ev.text, ev.cls || '', ev.cr);
            break;
          case 'fig': {
            flushBlock();
            const canvas = el('canvas', {});
            canvas.style.height = (ev.height || 150) + 'px';
            const box = el('div', { class: 'out-fig' }, [
              canvas,
              el('div', { class: 'fig-cap', text: ev.caption || '' }),
            ]);
            outs.appendChild(box);
            figs.set(ev.id, { canvas, draw: ev.draw });
            Promise.resolve(ev.draw(canvas)).catch(() => {});
            break;
          }
          case 'figTick': {
            const f = figs.get(ev.id);
            if (f) Promise.resolve(f.draw(f.canvas)).catch(() => {});
            break;
          }
          case 'audio': {
            flushBlock();
            outs.appendChild(this.audioBox(ev));
            break;
          }
          case 'table': {
            flushBlock();
            const table = el('table', { class: 'out-table' });
            table.innerHTML =
              `<thead><tr>${ev.headers.map((h) => `<th>${esc(h)}</th>`).join('')}</tr></thead>` +
              `<tbody>${ev.rows.map((r) => `<tr>${r.map((c) => `<td>${esc(c)}</td>`).join('')}</tr>`).join('')}</tbody>`;
            outs.appendChild(table);
            break;
          }
          case 'metrics': {
            flushBlock();
            outs.appendChild(el('div', { class: 'out-metrics' },
              ev.items.map((m) => el('div', { class: 'out-metric' }, [
                el('div', { class: 'om-k', text: m.k }),
                el('div', { class: 'om-v', text: m.v }),
              ]))));
            break;
          }
          case 'error': {
            flushBlock();
            outs.appendChild(el('pre', { class: 'out-block err', text: ev.text }));
            failed = true;
            break;
          }
        }
      }
    } catch (e) {
      outs.appendChild(el('pre', { class: 'out-block err', text: String(e?.message || e) }));
      failed = true;
    }

    const ms = performance.now() - t0;
    cell.tookMs = ms;
    cell.count = failed ? cell.count : ++this.execCounter;
    node.classList.remove('is-running');
    countEl.classList.remove('busy');
    countEl.textContent = failed ? '✗' : cell.count;
    countEl.style.color = failed ? 'var(--red)' : '';
    const timeEl = node.querySelector('.cell-time');
    if (timeEl) timeEl.textContent = `${fmt(ms / 1000, 2)}s`;
    this.busy = false;
    this.app.setKernelBusy(false);
    if (!failed) this.app.markSaved();
    return !failed;
  }

  audioBox(ev) {
    const canvas = el('canvas', {});
    canvas.style.height = '52px';
    canvas.style.width = '260px';
    const btn = el('button', { class: 'btn btn-ghost sm', text: '▶ play' });
    let stopFn = null;
    btn.addEventListener('click', () => {
      if (stopFn) { stopFn(); stopFn = null; btn.textContent = '▶ play'; return; }
      btn.textContent = '■ stop';
      stopFn = play(ev.samples, ev.sr, () => { btn.textContent = '▶ play'; stopFn = null; });
    });
    const dl = el('button', { class: 'btn btn-ghost sm', text: '⤓ wav', onclick: () => downloadBlob(toWavBlob(ev.samples, ev.sr), 'output.wav') });
    requestAnimationFrame(() => drawWaveform(canvas, ev.samples, { color: '#20beff' }));
    return el('div', { class: 'out-audio' }, [
      btn,
      el('div', { style: { flex: '1' } }, [canvas]),
      el('span', { class: 'oa-label', text: ev.label }),
      dl,
    ]);
  }

  /* ══════ Run All ══════ */
  async runAll() {
    if (this.busy) return;
    this.execCounter = 0;
    this.app.state.cells.forEach((c) => { if (c.type === 'code') c.count = undefined; });
    this.app.setKernelStatus('Starting…');
    await new Promise((r) => setTimeout(r, 260));
    for (const cell of this.app.state.cells) {
      if (cell.type !== 'code') continue;
      const node = this.host.querySelector(`[data-id="${cell.id}"]`);
      if (node && node.querySelector('.exec-count')) node.querySelector('.exec-count').textContent = '[*]';
      this.busy = false;
      const ok = await this._run(cell);
      if (!ok) { toast('Run All 中断：单元格出错', 'err'); break; }
    }
    this.app.setKernelStatus('Idle');
    this.app.markSaved();
  }

  clearOutputs() {
    this.app.state.cells.forEach((c) => { c.count = undefined; c.tookMs = null; });
    this.render();
    toast('已清空所有输出');
  }
}

/* ══════ 简易 markdown ══════ */
function mdToHtml(src) {
  return String(src)
    .split('\n')
    .map((line) => {
      let t = esc(line);
      t = t.replace(/`([^`]+)`/g, '<code>$1</code>');
      t = t.replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>');
      t = t.replace(/\*([^*]+)\*/g, '<i>$1</i>');
      if (/^###\s+/.test(line)) return `<h3>${t.replace(/^###\s+/, '')}</h3>`;
      if (/^##\s+/.test(line)) return `<h2>${t.replace(/^##\s+/, '')}</h2>`;
      if (/^#\s+/.test(line)) return `<h2>${t.replace(/^#\s+/, '')}</h2>`;
      if (/^\s*[-*]\s+/.test(line)) return `<p>• ${t.replace(/^\s*[-*]\s+/, '')}</p>`;
      if (line.trim() === '') return '';
      return `<p>${t}</p>`;
    })
    .join('');
}
