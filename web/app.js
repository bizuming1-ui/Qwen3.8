(() => {
  'use strict';

  const DRAFT_KEY = 'qwen38-voice-lab-draft-v1';
  const $ = (selector) => document.querySelector(selector);
  const editor = $('#codeEditor');
  const nameInput = $('#notebookName');
  const lineNumbers = $('#lineNumbers');
  const saveStatus = $('#saveStatus');
  const checksContainer = $('#checksContainer');
  const dialog = $('#aboutDialog');
  let currentNotebook = null;
  let mostRecentChecks = [];
  let toastSequence = 0;

  const runtimeNames = {
    'local-cpu': '本地 CPU（模拟）',
    'kaggle-t4': 'Kaggle T4（模拟）',
    'kaggle-p100': 'Kaggle P100（模拟）',
  };

  function showToast(message, kind = 'success') {
    const region = $('#toastRegion');
    const toast = document.createElement('div');
    const symbol = document.createElement('span');
    const text = document.createElement('span');
    const id = ++toastSequence;
    toast.className = `toast ${kind}`;
    toast.dataset.toastId = String(id);
    symbol.className = 'toast-symbol';
    symbol.textContent = kind === 'error' ? '!' : '✓';
    text.textContent = message;
    toast.append(symbol, text);
    region.append(toast);
    window.setTimeout(() => toast.remove(), 4200);
  }

  async function requestJson(url, options = {}) {
    const response = await fetch(url, {
      ...options,
      headers: { ...(options.body ? { 'Content-Type': 'application/json' } : {}), ...(options.headers || {}) },
    });
    let data;
    try {
      data = await response.json();
    } catch {
      throw new Error(`服务器返回了无法读取的响应（HTTP ${response.status}）`);
    }
    if (!response.ok) throw new Error(data.error || `请求失败（HTTP ${response.status}）`);
    return data;
  }

  function currentRuntime() {
    return $('#runtimeSelect').value;
  }

  function markSaved(label = '已保存到项目') {
    saveStatus.className = 'save-status saved';
    saveStatus.lastElementChild.textContent = label;
  }

  function markUnsaved() {
    saveStatus.className = 'save-status unsaved';
    saveStatus.lastElementChild.textContent = '有未保存改动';
  }

  function updateLineNumbers() {
    const count = Math.max(1, editor.value.split('\n').length);
    const maxDisplay = Math.min(count, 100000);
    lineNumbers.textContent = Array.from({ length: maxDisplay }, (_, index) => String(index + 1)).join('\n');
    if (count > maxDisplay) lineNumbers.textContent += '\n…';
    lineNumbers.scrollTop = editor.scrollTop;
    const characters = editor.value.length;
    $('#codeStats').innerHTML = `${count.toLocaleString('zh-CN')} 行&nbsp; · &nbsp;${characters.toLocaleString('zh-CN')} 字符`;
  }

  function rememberDraft() {
    const draft = {
      name: nameInput.value,
      code: editor.value,
      runtime: currentRuntime(),
      saved_at: Date.now(),
    };
    try {
      if (draft.code.length <= 2_000_000) {
        localStorage.setItem(DRAFT_KEY, JSON.stringify(draft));
      } else {
        localStorage.removeItem(DRAFT_KEY);
      }
    } catch {
      // The project save API remains the source of truth if browser storage is full/disabled.
    }
  }

  function markEditorChanged() {
    currentNotebook = null;
    markUnsaved();
    updateLineNumbers();
    rememberDraft();
  }

  function makeSlug(value) {
    return /^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/.test(value.trim());
  }

  function syncRuntime(from = 'toolbar', dirty = true) {
    const value = from === 'toolbar' ? $('#runtimeSelect').value : $('#simRuntime').value;
    $('#runtimeSelect').value = value;
    $('#simRuntime').value = value;
    const runtime = runtimeNames[value] || runtimeNames['local-cpu'];
    $('#footerRuntime').textContent = `Python 3 · ${runtime}静态预检`;
    if (dirty) {
      markUnsaved();
      rememberDraft();
    }
  }

  function setConnection(connected, detail = '') {
    const dot = $('#connectionDot');
    dot.className = `status-dot ${connected ? 'connected' : 'disconnected'}`;
    $('#connectionText').textContent = connected ? '项目保存服务已连接' : '项目保存服务未连接';
    $('#connectionSubtext').textContent = connected ? (detail || '可写入当前 Git 项目') : (detail || '启动 python3 server.py 后重试');
    const chip = document.querySelector('.persistence-chip');
    chip.title = connected ? '保存按钮会将文件写入当前项目目录' : '目前只能在浏览器中保留临时草稿';
  }

  async function checkHealth() {
    try {
      const health = await requestJson('/api/health');
      setConnection(Boolean(health.ok), `${health.persistence} · Python ${health.python}`);
    } catch (error) {
      setConnection(false, error.message);
    }
  }

  function formatDate(value) {
    if (!value) return '时间未知';
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return '时间未知';
    return new Intl.DateTimeFormat('zh-CN', { month: 'short', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).format(date);
  }

  function renderNotebookTree(notebooks) {
    const tree = $('#notebookTree');
    $('#notebookCount').textContent = String(notebooks.length);
    tree.replaceChildren();
    if (!notebooks.length) {
      const empty = document.createElement('div');
      empty.className = 'tree-empty';
      empty.textContent = '保存后的 Notebook 会显示在这里';
      tree.append(empty);
      return;
    }
    for (const notebook of notebooks) {
      const button = document.createElement('button');
      const icon = document.createElement('span');
      const title = document.createElement('span');
      button.type = 'button';
      button.className = `tree-notebook${currentNotebook === notebook.name ? ' selected' : ''}`;
      button.title = `${notebook.title || notebook.name} · ${notebook.source_file}`;
      icon.className = 'tree-file-icon';
      icon.textContent = 'Py';
      title.textContent = notebook.name;
      button.append(icon, title);
      button.addEventListener('click', () => loadNotebook(notebook.name));
      tree.append(button);
    }
  }

  async function refreshNotebooks() {
    try {
      const notebooks = await requestJson('/api/notebooks');
      window.cachedNotebooks = notebooks;
      renderNotebookTree(notebooks);
      return notebooks;
    } catch (error) {
      console.warn('Could not load project notebooks:', error);
      return [];
    }
  }

  function renderExperiments(records) {
    const list = $('#experimentsList');
    const count = records.length;
    $('#historyCount').textContent = String(count);
    $('#experimentCount').textContent = String(count);
    list.replaceChildren();
    if (!count) {
      const empty = document.createElement('div');
      empty.className = 'history-empty';
      empty.textContent = '尚无预演记录';
      list.append(empty);
      return;
    }
    for (const record of records.slice(0, 8)) {
      const card = document.createElement('div');
      const icon = document.createElement('span');
      const copy = document.createElement('span');
      const title = document.createElement('strong');
      const details = document.createElement('span');
      const status = document.createElement('span');
      card.className = 'experiment-card';
      icon.className = 'experiment-icon';
      icon.textContent = '⌁';
      copy.className = 'experiment-copy';
      title.textContent = record.notebook_name || 'Notebook';
      details.textContent = `${formatDate(record.created_at)} · ${record.checks?.length || 0} 项检查`;
      status.className = 'experiment-status';
      status.textContent = '仅静态预检';
      copy.append(title, details);
      card.append(icon, copy, status);
      card.title = '此记录未执行 Python 或模型训练';
      list.append(card);
    }
  }

  async function refreshExperiments() {
    try {
      const records = await requestJson('/api/experiments?limit=30');
      renderExperiments(records);
      return records;
    } catch (error) {
      console.warn('Could not load experiment records:', error);
      return [];
    }
  }

  async function loadNotebook(name) {
    try {
      const notebook = await requestJson(`/api/notebooks/${encodeURIComponent(name)}`);
      nameInput.value = notebook.name;
      editor.value = notebook.code;
      $('#runtimeSelect').value = notebook.runtime && Object.keys(runtimeNames).find((key) => runtimeNames[key] === notebook.runtime) ? Object.keys(runtimeNames).find((key) => runtimeNames[key] === notebook.runtime) : 'local-cpu';
      $('#simRuntime').value = $('#runtimeSelect').value;
      currentNotebook = notebook.name;
      updateLineNumbers();
      markSaved('已从项目加载');
      try { localStorage.removeItem(DRAFT_KEY); } catch { /* ignore */ }
      await refreshNotebooks();
      showToast(`已从项目加载 ${notebook.name}.py`, 'success');
      window.scrollTo({ top: 0, behavior: 'smooth' });
    } catch (error) {
      showToast(error.message, 'error');
    }
  }

  function buildChecks(code, runtime) {
    const lines = code.split(/\r?\n/);
    const markers = lines.filter((line) => /^\s*#\s*%%/.test(line));
    const firstMarkerIndex = lines.findIndex((line) => /^\s*#\s*%%/.test(line));
    const hasPreamble = firstMarkerIndex > 0 && lines.slice(0, firstMarkerIndex).some((line) => line.trim());
    const cellCount = markers.length ? markers.length + (hasPreamble ? 1 : 0) : (code.trim() ? 1 : 0);
    const kaggleInput = /\/kaggle\/input(?:\/|\b)/i.test(code);
    const kaggleWorking = /\/kaggle\/working(?:\/|\b)/i.test(code);
    const gpuReference = /\b(?:cuda|gpu|mps)\b|torch\.device|list_physical_devices/i.test(code);
    const shellMagics = lines.filter((line) => /^\s*[!%]/.test(line));
    const voiceLibraries = [...new Set((code.match(/\b(?:torch|torchaudio|librosa|transformers|soundfile|TTS|f5_tts|whisper)\b/gi) || []).map((item) => item.toLowerCase()))];
    const runtimeName = runtimeNames[runtime] || runtimeNames['local-cpu'];
    const checks = [
      {
        label: 'Notebook 内容',
        detail: `${code.length.toLocaleString('zh-CN')} 字符 · ${lines.length.toLocaleString('zh-CN')} 行 · 识别到 ${cellCount} 个代码单元。`,
        status: 'ok',
      },
      {
        label: 'Kaggle 文件路径',
        detail: kaggleInput || kaggleWorking
          ? `发现 Kaggle 路径${kaggleInput ? ' /kaggle/input' : ''}${kaggleWorking ? ' /kaggle/working' : ''}；本地项目不会自动挂载这些数据。`
          : '未发现 /kaggle/input 或 /kaggle/working 路径引用。',
        status: kaggleInput || kaggleWorking ? 'warning' : 'ok',
      },
      {
        label: '加速器引用',
        detail: gpuReference
          ? `代码包含 GPU/CUDA 相关引用；当前选择 ${runtimeName}，这里只记录配置，不代表有可用 GPU。`
          : `未检测到常见 GPU/CUDA 引用；配置为 ${runtimeName}。`,
        status: gpuReference ? 'warning' : 'info',
      },
      {
        label: 'Notebook 命令',
        detail: shellMagics.length
          ? `发现 ${shellMagics.length} 行以 ! 或 % 开头的 Notebook 命令；本地预检不会执行它们。`
          : '未发现以 ! 或 % 开头的 Kaggle/Jupyter shell magic。',
        status: shellMagics.length ? 'warning' : 'ok',
      },
      {
        label: '语音/音频依赖线索',
        detail: voiceLibraries.length
          ? `文本中出现：${voiceLibraries.slice(0, 6).join(', ')}${voiceLibraries.length > 6 ? ' 等' : ''}；此检查不验证依赖是否已安装。`
          : '未从代码文本中识别出常见语音/音频库名称；不影响保存。',
        status: 'info',
      },
    ];
    return { checks, cellCount, lines: lines.length, runtimeName };
  }

  function renderChecks(checks) {
    checksContainer.replaceChildren();
    for (const check of checks) {
      const item = document.createElement('div');
      const icon = document.createElement('span');
      const copy = document.createElement('span');
      const label = document.createElement('strong');
      const detail = document.createElement('span');
      item.className = `check-item ${check.status}`;
      icon.className = 'check-icon';
      icon.textContent = check.status === 'ok' ? '✓' : check.status === 'warning' ? '!' : 'i';
      copy.className = 'check-copy';
      label.textContent = check.label;
      detail.textContent = check.detail;
      copy.append(label, detail);
      item.append(icon, copy);
      checksContainer.append(item);
    }
    const warnings = checks.some((check) => check.status === 'warning');
    const badge = $('#reportBadge');
    badge.className = `report-state ${warnings ? 'warning' : 'ready'}`;
    badge.textContent = warnings ? '有环境提示' : '预检完成';
  }

  function getConfig() {
    const safeNumber = (selector, fallback, min, max) => {
      const raw = Number($(selector).value);
      return Number.isFinite(raw) ? Math.max(min, Math.min(max, Math.round(raw))) : fallback;
    };
    return {
      runtime: $('#simRuntime').value,
      epochs: safeNumber('#epochsInput', 50, 1, 9999),
      batch_size: safeNumber('#batchInput', 16, 1, 4096),
      sample_rate: safeNumber('#sampleRateInput', 24000, 8000, 192000),
    };
  }

  async function runPreflight() {
    const code = editor.value;
    if (!code.trim()) {
      showToast('先粘贴或导入 Notebook 代码，再生成预检报告。', 'error');
      editor.focus();
      return;
    }
    if (!makeSlug(nameInput.value)) {
      showToast('文件名仅支持 1–80 位英文字母、数字、连字符或下划线，且首位须为字母或数字。', 'error');
      nameInput.focus();
      return;
    }
    const button = $('#preflightButton');
    const shortcut = $('#runShortcut');
    const oldLabel = button.querySelector('span:nth-child(2)').textContent;
    button.disabled = true;
    shortcut.disabled = true;
    button.querySelector('span:nth-child(2)').textContent = '正在进行静态预检…';
    $('#reportBadge').textContent = '检查中';
    await new Promise((resolve) => window.setTimeout(resolve, 220));
    const runtime = $('#simRuntime').value;
    const report = buildChecks(code, runtime);
    mostRecentChecks = report.checks;
    renderChecks(report.checks);
    const payload = {
      notebook_name: nameInput.value.trim(),
      config: getConfig(),
      code_stats: { characters: code.length, lines: report.lines, cells: report.cellCount },
      checks: report.checks,
    };
    try {
      const record = await requestJson('/api/experiments', { method: 'POST', body: JSON.stringify(payload) });
      const records = await requestJson('/api/experiments?limit=30');
      renderExperiments(records);
      showToast(`静态预检已记录到 experiments/（${record.id}）；未执行 Python。`, 'success');
    } catch (error) {
      showToast(`预检报告已显示，但未能写入项目记录：${error.message}`, 'error');
    } finally {
      button.disabled = false;
      shortcut.disabled = false;
      button.querySelector('span:nth-child(2)').textContent = oldLabel;
    }
  }

  async function saveNotebook() {
    const code = editor.value;
    const name = nameInput.value.trim();
    if (!code.trim()) {
      showToast('编辑区目前为空。粘贴代码后再保存。', 'error');
      editor.focus();
      return;
    }
    if (!makeSlug(name)) {
      showToast('文件名仅支持 1–80 位英文字母、数字、连字符或下划线，且首位须为字母或数字。', 'error');
      nameInput.focus();
      return;
    }
    const button = $('#saveButton');
    button.disabled = true;
    button.querySelector('span:last-child').textContent = '正在保存…';
    try {
      const result = await requestJson('/api/notebooks', {
        method: 'POST',
        body: JSON.stringify({ name, title: name, code, runtime: runtimeNames[currentRuntime()] }),
      });
      currentNotebook = result.name;
      markSaved('已保存到项目');
      try { localStorage.removeItem(DRAFT_KEY); } catch { /* ignore */ }
      await refreshNotebooks();
      showToast(`已写入 ${result.source_file} 和 ${result.notebook_file}`, 'success');
    } catch (error) {
      markUnsaved();
      showToast(`项目保存失败：${error.message}`, 'error');
    } finally {
      button.disabled = false;
      button.querySelector('span:last-child').textContent = '保存到项目';
    }
  }

  function notebookToScript(notebook) {
    if (!notebook || !Array.isArray(notebook.cells)) throw new Error('这个文件不是有效的 Jupyter Notebook。');
    const pieces = [];
    for (const cell of notebook.cells) {
      if (!cell || !['code', 'markdown', 'raw'].includes(cell.cell_type)) continue;
      const source = Array.isArray(cell.source) ? cell.source.join('') : String(cell.source || '');
      if (cell.cell_type === 'markdown') {
        const commented = source.split(/\r?\n/).map((line) => line ? `# ${line}` : '#').join('\n');
        pieces.push(`# %% [markdown]\n${commented}`);
      } else if (cell.cell_type === 'raw') {
        pieces.push(`# %% [raw]\n${source}`);
      } else {
        pieces.push(`# %%\n${source}`);
      }
    }
    return pieces.join('\n\n').replace(/\n?$/, '\n');
  }

  function slugFromFilename(filename) {
    const base = filename.replace(/\.(ipynb|py)$/i, '');
    const slug = base.replace(/[^A-Za-z0-9_-]+/g, '-').replace(/^[^A-Za-z0-9]+/, '').slice(0, 80);
    return makeSlug(slug) ? slug : 'voice-clone-experiment';
  }

  async function importFile(file) {
    if (!file) return;
    try {
      const contents = await file.text();
      if (/\.ipynb$/i.test(file.name)) {
        const notebook = JSON.parse(contents);
        editor.value = notebookToScript(notebook);
      } else if (/\.py$/i.test(file.name) || /text\//i.test(file.type) || !file.type) {
        editor.value = contents;
      } else {
        throw new Error('请导入 .py 或 .ipynb 文件。');
      }
      nameInput.value = slugFromFilename(file.name);
      currentNotebook = null;
      markUnsaved();
      updateLineNumbers();
      rememberDraft();
      showToast(`已导入 ${file.name}；点击“保存到项目”后才会写入仓库。`, 'success');
    } catch (error) {
      showToast(`导入失败：${error.message}`, 'error');
    } finally {
      $('#fileInput').value = '';
    }
  }

  function restoreDraft() {
    try {
      const value = localStorage.getItem(DRAFT_KEY);
      if (!value) return;
      const draft = JSON.parse(value);
      if (!draft || typeof draft.code !== 'string' || !draft.code) return;
      editor.value = draft.code;
      if (typeof draft.name === 'string' && makeSlug(draft.name)) nameInput.value = draft.name;
      if (Object.hasOwn(runtimeNames, draft.runtime)) {
        $('#runtimeSelect').value = draft.runtime;
        $('#simRuntime').value = draft.runtime;
      }
      markUnsaved();
      showToast('已恢复浏览器中的未保存草稿；仍需“保存到项目”才会写入文件。', 'success');
    } catch {
      // Ignore malformed or unavailable local drafts.
    }
  }

  editor.addEventListener('input', markEditorChanged);
  editor.addEventListener('scroll', () => { lineNumbers.scrollTop = editor.scrollTop; });
  nameInput.addEventListener('input', () => {
    currentNotebook = null;
    markUnsaved();
    rememberDraft();
    renderNotebookTree(window.cachedNotebooks || []);
  });
  $('#runtimeSelect').addEventListener('change', () => syncRuntime('toolbar'));
  $('#simRuntime').addEventListener('change', () => syncRuntime('simulator'));
  $('#saveButton').addEventListener('click', saveNotebook);
  $('#preflightButton').addEventListener('click', runPreflight);
  $('#runShortcut').addEventListener('click', runPreflight);
  $('#fileInput').addEventListener('change', (event) => importFile(event.target.files?.[0]));
  $('#copyButton').addEventListener('click', async () => {
    if (!editor.value) return showToast('编辑区没有可复制的代码。', 'error');
    try {
      await navigator.clipboard.writeText(editor.value);
      showToast('已复制全部代码。', 'success');
    } catch {
      editor.focus();
      editor.select();
      showToast('浏览器阻止了剪贴板访问；代码已选中，可按 Ctrl+C / ⌘C。', 'error');
    }
  });
  $('#clearButton').addEventListener('click', () => {
    if (!editor.value || window.confirm('清空当前编辑器中的代码？已保存到项目的文件不会被删除。')) {
      editor.value = '';
      currentNotebook = null;
      markEditorChanged();
      showToast('编辑区已清空；项目中已保存的 Notebook 不受影响。', 'success');
    }
  });
  document.querySelectorAll('.nav-item').forEach((button) => {
    button.addEventListener('click', () => {
      document.querySelectorAll('.nav-item').forEach((item) => item.classList.toggle('active', item === button));
      const target = button.dataset.target;
      if (target === 'historyPanel') $('#historyPanel').scrollIntoView({ behavior: 'smooth', block: 'center' });
      else window.scrollTo({ top: 0, behavior: 'smooth' });
    });
  });
  $('#aboutButton').addEventListener('click', () => dialog.showModal());
  $('#helpButton').addEventListener('click', () => dialog.showModal());
  dialog.addEventListener('click', (event) => {
    if (event.target === dialog) dialog.close();
  });

  window.cachedNotebooks = [];
  updateLineNumbers();
  restoreDraft();
  syncRuntime('toolbar', false);
  checkHealth();
  refreshNotebooks().then((notebooks) => {
    window.cachedNotebooks = notebooks;
    renderNotebookTree(notebooks);
  });
  refreshExperiments();
})();
