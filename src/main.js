/** main.js — 应用装配 */
import { $, $$, el, toast, fmtClock, fmtBytes, clamp, sleep } from './util.js';
import { SPEAKERS, NOTEBOOK_CELLS, DEMO_CELLS, KAGGLE_CELLS, KAGGLE_SOURCE } from './data.js';
import { parseNotebookText, cellsToIpynb, summarize } from './ipynb.js';
import { downloadBlob } from './util.js';
import { FakeKernel } from './kernel.js';
import { Notebook } from './notebook.js';
import { Studio } from './studio.js';
import { DataView } from './dataview.js';
import { RunsManager } from './runs.js';

const STORAGE_KEY = 'kaggle-sim-voiceclone-v1';

const DEFAULTS = {
  cells: NOTEBOOK_CELLS.map((c) => ({ ...c, id: 'c' + Math.random().toString(36).slice(2, 9) })),
  accelerator: 't4x2',
  internet: true,
  speakerId: 'chen',
  uploadedSpeakers: [],
  uploadedBytes: 0,
  speed: 1,
  expr: 0.65,
  pitchShift: 0,
  studioText: '你好，这是用你的声音合成的一段话。声音克隆系统已经跑在你的 Kaggle notebook 里了。',
  activeDataset: 'ljspeech',
  files: [
    { name: 'ckpt_e20.pt', size: 50790 },
    { name: 'train.log', size: 128 },
  ],
  runs: [],
  modelEpoch: 20,
  notebookName: 'voice-clone-lab.ipynb',
  notebookSource: KAGGLE_CELLS && KAGGLE_CELLS.length ? KAGGLE_SOURCE : null,
  ram: 3.1,
  disk: 4.2,
};

const app = {
  state: null,
  saveTimer: null,

  async init() {
    this.state = this.load();
    if (this.state.notebookSource && this.state.notebookSource.name) {
      this.state.notebookName = this.state.notebookSource.name.split('/').pop();
    }

    // 实例
    this.kernel = new FakeKernel(this);
    this.notebook = new Notebook(this, $('#notebook'));
    this.studio = new Studio(this);
    this.dataView = new DataView(this);
    this.runs = new RunsManager(this);

    this.bindChrome();
    this.renderFiles();
    this.notebook.render();
    this.studio.renderSpeakers();
    this.startMeters();
    this.startClock();

    // 首帧预热一个音色 profile（让 Studio 打开即有雷达图）
    setTimeout(() => this.studio.renderDetail(), 120);

    // 恢复 UI 控件
    $('#internetCheck').checked = this.state.internet;
    $('#accelerator').value = this.state.accelerator;
    this.updateEnvLine();
    this.renderSource();
  },

  load() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return structuredClone(DEFAULTS);
      const saved = JSON.parse(raw);
      const merged = { ...structuredClone(DEFAULTS), ...saved };
      // 丢弃运行时字段
      merged.cells = (merged.cells || []).map((c) => ({
        id: c.id, type: c.type, source: c.source, count: c.count, tookMs: c.tookMs,
      })).filter((c) => c.type);
      // 上传的音频不能序列化，过滤掉无法重建的
      merged.uploadedSpeakers = (merged.uploadedSpeakers || []).filter((s) => Array.isArray(s.embedding));
      if (!merged.cells || !merged.cells.length) {
        merged.cells = structuredClone(DEFAULTS.cells);
      }
      return merged;
    } catch {
      return structuredClone(DEFAULTS);
    }
  },

  save() {
    try {
      const s = this.state;
      const payload = {
        ...s,
        cells: s.cells.map((c) => ({ id: c.id, type: c.type, source: c.source, count: c.count, tookMs: c.tookMs })),
        uploadedSpeakers: s.uploadedSpeakers.map((sp) => ({
          id: sp.id, name: sp.name, tag: sp.tag, lang: sp.lang, color: sp.color,
          f0: sp.f0, formantScale: sp.formantScale, breath: sp.breath, brightness: sp.brightness,
          dataset: sp.dataset, samples: sp.samples, license: sp.license, desc: sp.desc,
          embedding: sp.embedding,
          analysis: sp.analysis ? {
            duration: sp.analysis.duration, f0: sp.analysis.f0, centroid: sp.analysis.centroid,
            rms: sp.analysis.rms, peak: sp.analysis.peak, zcr: sp.analysis.zcr,
            embedding: sp.analysis.embedding, voiced: sp.analysis.voiced,
          } : null,
        })),
      };
      delete payload.refSamples; delete payload.refSr; delete payload.refAnalysis;
      localStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
    } catch (e) { /* 容量不足时忽略 */ }
  },

  markDirty() {
    const hint = $('#saveHint');
    if (hint) hint.classList.remove('show');
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => { this.save(); this.markSaved(); }, 700);
  },
  markSaved() {
    const hint = $('#saveHint');
    if (!hint) return;
    hint.classList.add('show');
    clearTimeout(this._savedTimer);
    this._savedTimer = setTimeout(() => hint.classList.remove('show'), 1600);
  },

  /* ══════ 数据/资源 ══════ */
  getSpeaker() {
    const all = [...SPEAKERS, ...this.state.uploadedSpeakers];
    return all.find((s) => s.id === this.state.speakerId) || all[0];
  },
  addFile(name, sizeKb, isNew = true) {
    if (this.state.files.some((f) => f.name === name)) return;
    this.state.files.push({ name, size: sizeKb, isNew });
    this.renderFiles();
  },
  setStudioOutput(samples, sr, an, spk, ms) {
    if (this.studio) this.studio.setOutput(samples, sr, an, spk, ms);
  },
  addDisk(gb) {
    this.state.disk = clamp((this.state.disk || 4.2) + gb, 0, 20);
    this.renderMeters();
  },
  ramBump(p) {
    this.state.ram = clamp(3.1 + p * 12, 0, 29);
  },
  setRunProgress() {},

  renderFiles() {
    const host = $('#fileTree');
    if (!host) return;
    host.innerHTML = '';
    const files = this.state.files.slice(-14);
    if (!files.length) {
      host.appendChild(el('li', { class: 'muted', text: '（空）' }));
      return;
    }
    for (const f of files) {
      host.appendChild(el('li', {}, [
        el('span', { text: '📄' }),
        el('span', { text: f.name }),
        f.isNew ? el('span', { class: 'new', text: 'new' }) : null,
        el('span', { class: 'fsz', text: f.size > 1024 ? `${(f.size / 1024).toFixed(1)}M` : `${f.size}K` }),
      ]));
    }
  },

  log(text, cls = '') {
    console.log(`%c[kernel] ${text}`, cls === 'ok' ? 'color:#37d399' : 'color:#8fa4c2');
    const t = document.getElementById('runLog');
    if (t && cls === 'ok') {
      const s = document.createElement('span');
      s.className = 'ok';
      s.textContent = `[kernel] ${text}\n`;
      t.appendChild(s);
      t.scrollTop = t.scrollHeight;
    }
  },

  setKernelBusy(busy, label) {
    const dot = $('#kernelDot'), st = $('#kernelStatus');
    if (!dot || !st) return;
    dot.className = 'status-dot ' + (busy ? 'busy' : 'idle');
    st.textContent = busy ? (label || 'Busy') : 'Idle';
  },
  setKernelStatus(t) {
    const st = $('#kernelStatus');
    if (st) st.textContent = t;
  },

  /* ══════ 顶栏 / 侧栏 ══════ */
  bindChrome() {
    $$('#tabs .tab').forEach((tab) => {
      tab.addEventListener('click', () => {
        $$('#tabs .tab').forEach((t) => t.classList.toggle('is-active', t === tab));
        const v = tab.dataset.view;
        $$('.view').forEach((s) => s.classList.toggle('is-active', s.id === 'view-' + v));
        if (v === 'studio') { this.studio.renderSpeakers(); setTimeout(() => this.studio.redraw(), 80); }
        if (v === 'data') this.dataView.renderDetail();
        if (v === 'runs') this.runs.renderTable();
      });
    });

    $('#runAllBtn').addEventListener('click', () => {
      $$('#tabs .tab').forEach((t) => t.classList.toggle('is-active', t.dataset.view === 'notebook'));
      $$('.view').forEach((s) => s.classList.toggle('is-active', s.id === 'view-notebook'));
      this.notebook.runAll();
    });

    $('#internetCheck').addEventListener('change', (e) => {
      this.state.internet = e.target.checked;
      this.markDirty();
      toast(e.target.checked ? 'Internet 已开启' : 'Internet 已关闭：pip / 下载会失败', e.target.checked ? 'ok' : 'warn');
    });

    $('#accelerator').addEventListener('change', (e) => {
      this.state.accelerator = e.target.value;
      this.updateEnvLine();
      this.renderMeters();
      this.markDirty();
      toast(`Accelerator → ${e.target.selectedOptions[0].textContent}（需 Restart kernel 生效）`, 'warn');
    });

    $('#restartBtn').addEventListener('click', () => {
      this.kernel = new FakeKernel(this);
      this.notebook.kernel = this.kernel;
      this.notebook.execCounter = 0;
      this.notebook.busy = false;
      this.notebook.clearOutputs();
      this.state.ram = 2.1;
      this.state.disk = 3.4;
      this.state.files = [];
      this.renderFiles();
      this.setKernelStatus('Idle');
      this.setKernelBusy(false);
      toast('Kernel 已重启，运行状态清空', 'ok');
    });

    $('#clearBtn').addEventListener('click', () => this.notebook.clearOutputs());

    // ── 导入真实 Kaggle 代码（.ipynb / .py）──
    $('#ipynbUpload').addEventListener('change', async (e) => {
      const file = e.target.files && e.target.files[0];
      if (!file) return;
      try {
        const text = await file.text();
        const { cells, meta } = parseNotebookText(text, file.name);
        if (!cells.length) { toast('文件里没有解析到单元格', 'warn'); return; }
        this.applyCells(cells, { name: file.name, importedAt: new Date().toISOString(), meta });
        const st = summarize(cells);
        toast(`已导入 ${file.name} · ${st.code} 个代码单元格 / ${st.lines} 行`, 'ok');
      } catch (err) {
        toast('导入失败：' + err.message, 'err');
      } finally {
        e.target.value = '';
      }
    });

    // ── 导出当前 notebook 为 .ipynb ──
    $('#exportBtn').addEventListener('click', () => {
      const nb = cellsToIpynb(this.state.cells, { name: this.state.notebookName });
      downloadBlob(new Blob([nb], { type: 'application/json' }), (this.state.notebookName || 'notebook').replace(/\.ipynb$/, '') + '.ipynb');
      toast('已导出 .ipynb（可直接放回 Kaggle）', 'ok');
    });

    // ── 载入项目里 kaggle/ 的真实代码 ──
    $('#reloadKaggleBtn').addEventListener('click', () => {
      if (!KAGGLE_CELLS || !KAGGLE_CELLS.length) {
        toast('kaggle/ 里还没有代码：把文件放进去并运行 npm run import:kaggle', 'warn');
        return;
      }
      this.applyCells(KAGGLE_CELLS, KAGGLE_SOURCE || { name: 'kaggle/' });
      toast(`已载入 kaggle/ 代码 · ${KAGGLE_CELLS.length} 个单元格`, 'ok');
    });

    // ── 恢复示例 notebook ──
    $('#resetNbBtn').addEventListener('click', () => {
      this.applyCells(DEMO_CELLS, null);
      toast('已恢复示例 notebook', 'ok');
    });
    $$('[data-add]').forEach((b) => b.addEventListener('click', () => this.notebook.addCell(b.dataset.add)));
    $('#addCellBottom').addEventListener('click', () => this.notebook.addCell('code'));

    // 分栏快捷键
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && e.shiftKey) {
        e.preventDefault();
        this.notebook.runAll();
      }
    });
  },

  /** 用一份单元格列表替换 notebook（重置执行状态） */
  applyCells(cells, source) {
    this.state.cells = cells.map((c) => ({
      id: 'c' + Math.random().toString(36).slice(2, 9),
      type: c.type === 'md' ? 'md' : 'code',
      source: String(c.source || ''),
      count: undefined,
      tookMs: null,
    }));
    this.state.notebookSource = source || null;
    this.state.notebookName = (source && source.name ? source.name.split('/').pop() : 'voice-clone-lab.ipynb');
    this.notebook.execCounter = 0;
    this.notebook.busy = false;
    this.notebook.render();
    this.renderSource();
    this.save();
    this.markSaved();
  },

  renderSource() {
    const badge = document.getElementById('nbSourceBadge');
    const nameEl = document.getElementById('nbFileName');
    const src = this.state.notebookSource;
    if (nameEl) nameEl.textContent = this.state.notebookName || 'voice-clone-lab.ipynb';
    if (!badge) return;
    if (src && (src.name || src.importedAt)) {
      badge.hidden = false;
      const codeCells = (src.meta && src.meta.codeCells) || this.state.cells.filter((c) => c.type === 'code').length;
      badge.textContent = `真实代码 · ${codeCells} code cells`;
      badge.title = `${src.name || ''}${src.importedAt ? '\n导入于 ' + new Date(src.importedAt).toLocaleString('zh-CN') : ''}`;
    } else {
      badge.hidden = true;
    }
  },

  updateEnvLine() {
    const map = {
      t4x2: 'Python 3.11.9 · torch 2.3.1+cu121 · 2×T4',
      p100: 'Python 3.11.9 · torch 2.3.1+cu121 · P100',
      tpu: 'Python 3.11.9 · torch_xla 2.3 · TPU v3-8',
      cpu: 'Python 3.11.9 · torch 2.3.1 (cpu)',
    };
    const env = $('#kernelEnv');
    if (env) env.textContent = map[this.state.accelerator] || map.t4x2;
  },

  /* ══════ 资源仪表 ══════ */
  renderMeters() {
    const set = (k, pct, text) => {
      const m = document.querySelector(`.meter[data-k="${k}"]`);
      if (!m) return;
      m.querySelector('.meter-fill').style.width = clamp(pct, 0, 100) + '%';
      m.querySelector('.meter-val').textContent = text;
    };
    const busy = document.querySelector('.status-dot.busy');
    const accel = this.state.accelerator || 't4x2';
    const vramTotal = accel === 't4x2' ? 30.7 : accel === 'p100' ? 16 : 0;
    const cpu = busy ? 62 + Math.random() * 30 : 8 + Math.random() * 9;
    set('cpu', cpu, `${cpu.toFixed(0)}%`);
    set('ram', (this.state.ram / 29) * 100, `${this.state.ram.toFixed(1)} / 29 GB`);
    const vused = vramTotal ? (busy ? 12.4 + Math.random() * 3 : 0.6) : 0;
    set('vram', vramTotal ? (vused / vramTotal) * 100 : 0, vramTotal ? `${vused.toFixed(1)} / ${vramTotal.toFixed(0)} GB` : '无 GPU');
    set('disk', (this.state.disk / 20) * 100, `${this.state.disk.toFixed(1)} / 20 GB`);
  },

  startMeters() {
    this.renderMeters();
    setInterval(() => {
      const busy = !!document.querySelector('.status-dot.busy');
      this.state.ram = clamp(this.state.ram + (Math.random() - 0.48) * 0.35 + (busy ? 0.5 : -0.2), 1.6, 26);
      this.renderMeters();
    }, 1200);
  },

  startClock() {
    let left = 12 * 3600;
    const elc = $('#sessionClock');
    setInterval(() => {
      left = Math.max(0, left - 1);
      if (elc) elc.textContent = fmtClock(left);
    }, 1000);
  },
};

// 一些跨模块的小工具挂到 app 上
app.fmtBytes = fmtBytes;
app.sleep = sleep;

window.app = app;
app.init();

// 全局错误提示（便于调试）
window.addEventListener('error', (e) => {
  console.error(e.error || e.message);
});
