import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import CodeMirror from '@uiw/react-codemirror';
import { python } from '@codemirror/lang-python';
import { markdown } from '@codemirror/lang-markdown';
import { oneDark } from '@codemirror/theme-one-dark';
import {
  AlertCircle,
  AudioWaveform,
  Check,
  CheckCircle2,
  Code2,
  Download,
  FileCode2,
  GitBranch,
  Github,
  Import,
  Info,
  LoaderCircle,
  Play,
  Plus,
  Save,
  Square,
  Type,
  X,
} from 'lucide-react';
import { CreateModal } from './components/CreateModal';
import { FileTree } from './components/FileTree';
import { ImportModal } from './components/ImportModal';
import { NotebookEditor } from './components/NotebookEditor';
import { OutputView } from './components/OutputView';
import { RuntimeSidebar } from './components/RuntimeSidebar';
import { SyncModal } from './components/SyncModal';
import { api } from './lib/api';
import {
  createCell,
  isNotebookPath,
  languageForPath,
  notebookFromScript,
  parseNotebook,
  serializeNotebook,
  type CellType,
  type NotebookDocument,
} from './lib/notebook';
import type { CellOutput } from './lib/notebook';
import type { ExecutionJob, JobOutput, RuntimeInfo, WorkspaceEntry } from './types';

const DEFAULT_PATH = 'working/voice_cloning.ipynb';
const SESSION_KEY = 'qwen-kaggle-workbench-session';
const wait = (milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds));

function browserSessionId() {
  const existing = localStorage.getItem(SESSION_KEY);
  if (existing) return existing;
  const created = crypto.randomUUID();
  localStorage.setItem(SESSION_KEY, created);
  return created;
}

interface Toast {
  id: string;
  type: 'success' | 'error' | 'info';
  title: string;
  detail?: string;
}

export default function App() {
  const sessionId = useMemo(browserSessionId, []);
  const [runtime, setRuntime] = useState<RuntimeInfo | null>(null);
  const [files, setFiles] = useState<WorkspaceEntry[]>([]);
  const [filesLoading, setFilesLoading] = useState(true);
  const [selectedPath, setSelectedPath] = useState(DEFAULT_PATH);
  const [notebook, setNotebook] = useState<NotebookDocument | null>(null);
  const [textContent, setTextContent] = useState('');
  const [fileLoading, setFileLoading] = useState(true);
  const [fileError, setFileError] = useState('');
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const [syncOpen, setSyncOpen] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [restarting, setRestarting] = useState(false);
  const [runningCells, setRunningCells] = useState<Set<string>>(new Set());
  const [runningAll, setRunningAll] = useState(false);
  const [scriptRunning, setScriptRunning] = useState(false);
  const [scriptOutputs, setScriptOutputs] = useState<CellOutput[]>([]);
  const [toasts, setToasts] = useState<Toast[]>([]);

  const revision = useRef(0);
  const fileLoadSequence = useRef(0);
  const executionCounter = useRef(1);
  const activeJobs = useRef(new Map<string, string>());
  const cancelRunAll = useRef(false);

  const showToast = useCallback((type: Toast['type'], title: string, detail?: string) => {
    const id = crypto.randomUUID();
    setToasts((current) => [...current, { id, type, title, detail }]);
    window.setTimeout(() => {
      setToasts((current) => current.filter((toast) => toast.id !== id));
    }, 5_000);
  }, []);

  const refreshFiles = useCallback(async () => {
    setFilesLoading(true);
    try {
      const result = await api.files();
      setFiles(result.files);
    } finally {
      setFilesLoading(false);
    }
  }, []);

  const refreshWorkspace = useCallback(async () => {
    const [fileResult, git] = await Promise.all([api.files(), api.gitStatus()]);
    setFiles(fileResult.files);
    setRuntime((current) => (current ? { ...current, git } : current));
  }, []);

  const loadFile = useCallback(async (path: string) => {
    const sequence = ++fileLoadSequence.current;
    revision.current += 1;
    setSelectedPath(path);
    setFileLoading(true);
    setFileError('');
    setScriptOutputs([]);
    try {
      const file = await api.readFile(path);
      if (sequence !== fileLoadSequence.current) return;
      if (isNotebookPath(path)) {
        setNotebook(parseNotebook(file.content));
        setTextContent('');
      } else {
        setNotebook(null);
        setTextContent(file.content);
      }
      setDirty(false);
    } catch (error) {
      if (sequence !== fileLoadSequence.current) return;
      setNotebook(null);
      setTextContent('');
      setFileError(error instanceof Error ? error.message : 'Could not open this file.');
      setDirty(false);
    } finally {
      if (sequence === fileLoadSequence.current) setFileLoading(false);
    }
  }, []);

  useEffect(() => {
    async function initialize() {
      try {
        const [runtimeInfo, fileResult] = await Promise.all([api.runtime(), api.files()]);
        setRuntime(runtimeInfo);
        setFiles(fileResult.files);
        await loadFile(DEFAULT_PATH);
      } catch (error) {
        setFileError(error instanceof Error ? error.message : 'Could not initialize the workbench.');
        showToast('error', 'Workbench initialization failed', error instanceof Error ? error.message : undefined);
      } finally {
        setFilesLoading(false);
        setFileLoading(false);
      }
    }
    void initialize();
  }, [loadFile, showToast]);

  const markDirty = useCallback(() => {
    revision.current += 1;
    setDirty(true);
  }, []);

  const saveCurrent = useCallback(
    async (notify = true) => {
      if (!selectedPath || fileError || fileLoading) return false;
      const savedRevision = revision.current;
      const savedPath = selectedPath;
      const content = notebook ? serializeNotebook(notebook) : textContent;
      setSaving(true);
      try {
        await api.writeFile(savedPath, content);
        if (revision.current === savedRevision) setDirty(false);
        await refreshWorkspace();
        if (notify) showToast('success', 'Saved to the real project', `kaggle/${savedPath}`);
        return true;
      } catch (error) {
        showToast('error', 'Save failed', error instanceof Error ? error.message : undefined);
        return false;
      } finally {
        setSaving(false);
      }
    },
    [fileError, fileLoading, notebook, refreshWorkspace, selectedPath, showToast, textContent],
  );

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
        event.preventDefault();
        void saveCurrent();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [saveCurrent]);

  useEffect(() => {
    const warn = (event: BeforeUnloadEvent) => {
      if (!dirty) return;
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty]);

  const selectFile = async (entry: WorkspaceEntry) => {
    if (entry.type === 'directory' || entry.path === selectedPath) return;
    if (dirty && !window.confirm('Discard unsaved editor changes and open another file?')) return;
    await loadFile(entry.path);
  };

  const handleDelete = async (entry: WorkspaceEntry) => {
    if (!window.confirm(`Delete /kaggle/${entry.path} from the project? This cannot be undone here.`)) return;
    try {
      await api.deleteEntry(entry.path);
      if (selectedPath === entry.path || selectedPath.startsWith(`${entry.path}/`)) {
        fileLoadSequence.current += 1;
        setSelectedPath('');
        setNotebook(null);
        setTextContent('');
        setDirty(false);
      }
      await refreshWorkspace();
      showToast('success', 'Deleted from the project', entry.path);
    } catch (error) {
      showToast('error', 'Delete failed', error instanceof Error ? error.message : undefined);
    }
  };

  const handleCreate = async (path: string, kind: 'file' | 'directory') => {
    setCreating(true);
    try {
      if (dirty && !(await saveCurrent(false))) throw new Error('Save the open file before creating another one.');
      await api.createEntry(path, kind);
      await refreshWorkspace();
      setCreateOpen(false);
      if (kind === 'file') await loadFile(path);
      showToast('success', `${kind === 'file' ? 'File' : 'Folder'} created`, `kaggle/${path}`);
    } finally {
      setCreating(false);
    }
  };

  const handleImport = async (path: string, content: string) => {
    setSaving(true);
    try {
      if (dirty && !(await saveCurrent(false))) throw new Error('The open file could not be saved before import.');
      let persistedContent = content;
      if (isNotebookPath(path)) {
        if (content.trimStart().startsWith('{')) {
          parseNotebook(content);
        } else {
          persistedContent = serializeNotebook(notebookFromScript(content));
        }
      }
      await api.writeFile(path, persistedContent);
      await refreshWorkspace();
      setImportOpen(false);
      await loadFile(path);
      showToast('success', 'Kaggle code imported to disk', `kaggle/${path}`);
    } finally {
      setSaving(false);
    }
  };

  const handleSync = async (message: string) => {
    setSyncing(true);
    try {
      if (dirty && !(await saveCurrent(false))) throw new Error('The open editor could not be saved. Nothing was pushed.');
      const result = await api.gitSync(message);
      setSyncOpen(false);
      await refreshWorkspace();
      showToast(
        'success',
        result.status === 'committed' ? `Pushed commit ${result.hash}` : 'GitHub is already up to date',
        `origin/${result.branch}`,
      );
    } finally {
      setSyncing(false);
    }
  };

  const mutateNotebook = useCallback(
    (mutator: (current: NotebookDocument) => NotebookDocument) => {
      setNotebook((current) => (current ? mutator(current) : current));
      markDirty();
    },
    [markDirty],
  );

  const updateCell = useCallback(
    (cellId: string, update: (cell: NotebookDocument['cells'][number]) => NotebookDocument['cells'][number]) => {
      mutateNotebook((current) => ({
        ...current,
        cells: current.cells.map((cell) => (cell.id === cellId ? update(cell) : cell)),
      }));
    },
    [mutateNotebook],
  );

  const applyJobOutputs = useCallback((cellId: string, outputs: JobOutput[]) => {
    setNotebook((current) =>
      current
        ? {
            ...current,
            cells: current.cells.map((cell) =>
              cell.id === cellId ? { ...cell, outputs: outputs.map((output) => ({ ...output })) } : cell,
            ),
          }
        : current,
    );
  }, []);

  const pollJob = useCallback(async (jobId: string, onOutputs: (outputs: JobOutput[]) => void) => {
    let job: ExecutionJob | null = null;
    while (!job || job.status === 'queued' || job.status === 'running') {
      if (job) await wait(450);
      job = await api.job(jobId);
      onOutputs(job.outputs);
    }
    return job;
  }, []);

  const runCell = useCallback(
    async (cellId: string): Promise<ExecutionJob | null> => {
      const cell = notebook?.cells.find((candidate) => candidate.id === cellId);
      if (!cell || cell.cell_type !== 'code' || runningCells.has(cellId)) return null;
      updateCell(cellId, (current) => ({
        ...current,
        outputs: [],
        execution_count: executionCounter.current++,
      }));
      setRunningCells((current) => new Set(current).add(cellId));
      try {
        const job = await api.execute(sessionId, cell.source, cellId);
        activeJobs.current.set(cellId, job.id);
        return await pollJob(job.id, (outputs) => applyJobOutputs(cellId, outputs));
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Execution failed.';
        applyJobOutputs(cellId, [{ name: 'error', text: message }]);
        showToast('error', 'Cell execution failed', message);
        return null;
      } finally {
        activeJobs.current.delete(cellId);
        setRunningCells((current) => {
          const next = new Set(current);
          next.delete(cellId);
          return next;
        });
      }
    },
    [applyJobOutputs, notebook, pollJob, runningCells, sessionId, showToast, updateCell],
  );

  const runAll = async () => {
    if (!notebook || runningAll) return;
    cancelRunAll.current = false;
    setRunningAll(true);
    try {
      for (const cell of notebook.cells) {
        if (cancelRunAll.current) break;
        if (cell.cell_type !== 'code' || !cell.source.trim()) continue;
        const result = await runCell(cell.id);
        if (!result || result.status === 'error') break;
      }
    } finally {
      setRunningAll(false);
    }
  };

  const runScript = async () => {
    if (scriptRunning || !selectedPath.toLowerCase().endsWith('.py')) return;
    setScriptRunning(true);
    setScriptOutputs([]);
    try {
      const job = await api.execute(sessionId, textContent);
      activeJobs.current.set('script', job.id);
      const result = await pollJob(job.id, (outputs) => setScriptOutputs(outputs.map((output) => ({ ...output }))));
      if (result.status === 'error') showToast('error', 'Script finished with an error', 'See the output console.');
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Execution failed.';
      setScriptOutputs([{ name: 'error', text: message }]);
      showToast('error', 'Script execution failed', message);
    } finally {
      activeJobs.current.delete('script');
      setScriptRunning(false);
    }
  };

  const stopJob = async (key: string) => {
    const jobId = activeJobs.current.get(key);
    if (!jobId) return;
    try {
      await api.stopJob(jobId);
    } catch (error) {
      showToast('error', 'Could not stop execution', error instanceof Error ? error.message : undefined);
    }
  };

  const stopAll = async () => {
    cancelRunAll.current = true;
    const keys = [...activeJobs.current.keys()];
    await Promise.all(keys.map((key) => stopJob(key)));
  };

  const restartKernel = async () => {
    if (activeJobs.current.size > 0 && !window.confirm('Restarting stops active executions and clears Python variables. Continue?')) return;
    setRestarting(true);
    try {
      cancelRunAll.current = true;
      await api.restartKernel(sessionId);
      showToast('success', 'Python kernel restarted', 'Variables from the previous session were cleared.');
    } catch (error) {
      showToast('error', 'Kernel restart failed', error instanceof Error ? error.message : undefined);
    } finally {
      setRestarting(false);
    }
  };

  const addCell = (type: CellType, index?: number) => {
    mutateNotebook((current) => {
      const cells = [...current.cells];
      cells.splice(index ?? cells.length, 0, createCell(type, ''));
      return { ...current, cells };
    });
  };

  const deleteCell = (cellId: string) => {
    mutateNotebook((current) => ({
      ...current,
      cells:
        current.cells.length === 1
          ? [createCell('code', '')]
          : current.cells.filter((cell) => cell.id !== cellId),
    }));
  };

  const moveCell = (cellId: string, direction: -1 | 1) => {
    mutateNotebook((current) => {
      const index = current.cells.findIndex((cell) => cell.id === cellId);
      const destination = index + direction;
      if (index < 0 || destination < 0 || destination >= current.cells.length) return current;
      const cells = [...current.cells];
      [cells[index], cells[destination]] = [cells[destination], cells[index]];
      return { ...current, cells };
    });
  };

  const isRunning = runningAll || runningCells.size > 0 || scriptRunning;
  const canRun = Boolean(notebook) || selectedPath.toLowerCase().endsWith('.py');
  const fileName = selectedPath.split('/').pop() || 'No file selected';
  const language = languageForPath(selectedPath);
  const textExtensions = language === 'python' ? [python()] : language === 'markdown' ? [markdown()] : [];

  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="brand">
          <span className="brand-mark"><AudioWaveform size={23} /></span>
          <div><strong>Qwen Lab</strong><span>KAGGLE WORKBENCH</span></div>
        </div>
        <div className="topbar-branch"><GitBranch size={14} /><span>{runtime?.git.branch || 'Loading branch…'}</span></div>
        <div className="topbar-actions">
          <span className={`save-indicator ${dirty ? 'unsaved' : ''}`}>
            {dirty ? <span className="unsaved-dot" /> : <Check size={13} />}
            {dirty ? 'Unsaved changes' : 'Saved on disk'}
          </span>
          <button className="button secondary import-button" onClick={() => setImportOpen(true)}><Import size={15} /> Import Kaggle</button>
          <button className="button secondary" onClick={() => void saveCurrent()} disabled={saving || !selectedPath || fileLoading || Boolean(fileError)}>
            {saving ? <LoaderCircle size={15} className="spin" /> : <Save size={15} />} Save
            <kbd>⌘S</kbd>
          </button>
          <button className="button github-button" onClick={() => setSyncOpen(true)}><Github size={16} /> Commit &amp; push</button>
        </div>
      </header>

      <div className="workbench-layout">
        <FileTree
          entries={files}
          selectedPath={selectedPath}
          loading={filesLoading}
          onSelect={(entry) => void selectFile(entry)}
          onCreate={() => setCreateOpen(true)}
          onImport={() => setImportOpen(true)}
          onRefresh={() => void refreshFiles().catch((error) => showToast('error', 'Refresh failed', error.message))}
          onDelete={(entry) => void handleDelete(entry)}
        />

        <main className="editor-pane">
          <div className="editor-header">
            <div className="editor-breadcrumb">
              <FileCode2 size={16} />
              <div><strong>{fileName}</strong><span>{selectedPath ? `/kaggle/${selectedPath}` : 'Select or import a file'}</span></div>
              {dirty && <span className="dirty-badge">MODIFIED</span>}
            </div>
            <div className="editor-actions">
              {selectedPath && (
                <a className="button icon-only secondary" href={`/api/files/raw?path=${encodeURIComponent(selectedPath)}`} download={fileName} title="Download real file"><Download size={15} /></a>
              )}
              <button
                className={`button run-button ${isRunning ? 'running' : ''}`}
                disabled={!canRun || (!notebook && language !== 'python')}
                onClick={() => void (isRunning ? stopAll() : notebook ? runAll() : runScript())}
              >
                {isRunning ? <Square size={14} fill="currentColor" /> : <Play size={14} fill="currentColor" />}
                {isRunning ? 'Stop' : notebook ? 'Run all' : 'Run'}
              </button>
            </div>
          </div>

          {notebook && (
            <div className="notebook-toolbar">
              <div>
                <button onClick={() => addCell('code')}><Plus size={13} /><Code2 size={14} /> Code</button>
                <button onClick={() => addCell('markdown')}><Plus size={13} /><Type size={14} /> Markdown</button>
              </div>
              <span><span className="status-dot online" /> Python 3 · Persistent local kernel</span>
            </div>
          )}

          <div className="editor-scroll">
            {fileLoading && <div className="editor-state"><LoaderCircle size={25} className="spin" /><p>Reading from the repository…</p></div>}
            {!fileLoading && fileError && (
              <div className="editor-state error-state"><AlertCircle size={26} /><h3>Could not open this file</h3><p>{fileError}</p><button className="button secondary" onClick={() => setImportOpen(true)}><Import size={15} /> Import code instead</button></div>
            )}
            {!fileLoading && !fileError && !selectedPath && (
              <div className="editor-state"><FileCode2 size={30} /><h3>Your persistent workspace is ready</h3><p>Import your Kaggle notebook or create a Python experiment.</p><div className="empty-actions"><button className="button primary" onClick={() => setImportOpen(true)}><Import size={15} /> Import Kaggle</button><button className="button secondary" onClick={() => setCreateOpen(true)}><Plus size={15} /> New file</button></div></div>
            )}
            {!fileLoading && !fileError && selectedPath && notebook && (
              <NotebookEditor
                notebook={notebook}
                runningCells={runningCells}
                onCellChange={(cellId, source) => updateCell(cellId, (cell) => ({ ...cell, source }))}
                onCellTypeChange={(cellId, type) => updateCell(cellId, (cell) => ({ ...cell, cell_type: type, outputs: type === 'markdown' ? [] : cell.outputs, execution_count: type === 'code' ? cell.execution_count : null }))}
                onAddCell={addCell}
                onDeleteCell={deleteCell}
                onMoveCell={moveCell}
                onRunCell={(cellId) => void runCell(cellId)}
                onStopCell={(cellId) => void stopJob(cellId)}
              />
            )}
            {!fileLoading && !fileError && selectedPath && !notebook && (
              <div className="text-file-editor">
                <CodeMirror
                  value={textContent}
                  onChange={(value) => { setTextContent(value); markDirty(); }}
                  extensions={textExtensions}
                  theme={oneDark}
                  minHeight="420px"
                  basicSetup={{ lineNumbers: true, foldGutter: true, highlightActiveLine: true }}
                  placeholder="Start writing, or import your Kaggle code…"
                />
                {(scriptOutputs.length > 0 || scriptRunning) && (
                  <section className="script-console">
                    <div className="console-heading"><span>OUTPUT</span>{scriptRunning && <LoaderCircle size={13} className="spin" />}</div>
                    <OutputView outputs={scriptOutputs} running={scriptRunning && scriptOutputs.length === 0} />
                  </section>
                )}
              </div>
            )}
          </div>
        </main>

        <RuntimeSidebar runtime={runtime} restarting={restarting} onRestart={() => void restartKernel()} onSync={() => setSyncOpen(true)} />
      </div>

      {importOpen && <ImportModal saving={saving} onClose={() => setImportOpen(false)} onImport={handleImport} />}
      {createOpen && <CreateModal creating={creating} onClose={() => setCreateOpen(false)} onCreate={handleCreate} />}
      {syncOpen && <SyncModal gitStatus={runtime?.git || null} dirty={dirty} syncing={syncing} onClose={() => setSyncOpen(false)} onSync={handleSync} />}

      <div className="toast-stack" aria-live="polite">
        {toasts.map((toast) => (
          <div className={`toast toast-${toast.type}`} key={toast.id}>
            {toast.type === 'success' ? <CheckCircle2 size={18} /> : toast.type === 'error' ? <AlertCircle size={18} /> : <Info size={18} />}
            <div><strong>{toast.title}</strong>{toast.detail && <span>{toast.detail}</span>}</div>
            <button onClick={() => setToasts((current) => current.filter((item) => item.id !== toast.id))} aria-label="Dismiss notification"><X size={14} /></button>
          </div>
        ))}
      </div>
    </div>
  );
}
