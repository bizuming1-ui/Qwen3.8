import {
  CheckCircle2,
  Cpu,
  FolderInput,
  GitBranch,
  Github,
  HardDrive,
  LoaderCircle,
  RotateCcw,
  ShieldCheck,
} from 'lucide-react';
import type { RuntimeInfo } from '../types';

interface RuntimeSidebarProps {
  runtime: RuntimeInfo | null;
  restarting: boolean;
  onRestart: () => void;
  onSync: () => void;
}

export function RuntimeSidebar({ runtime, restarting, onRestart, onSync }: RuntimeSidebarProps) {
  return (
    <aside className="runtime-sidebar">
      <section className="inspector-card">
        <div className="inspector-title">
          <span><Cpu size={15} /> Runtime</span>
          <span className="status-dot online" />
        </div>
        <div className="runtime-version">
          <strong>Python {runtime?.pythonVersion || '…'}</strong>
          <span>Persistent session</span>
        </div>
        <dl className="runtime-details">
          <div><dt>Working</dt><dd>/kaggle/working</dd></div>
          <div><dt>Input</dt><dd>/kaggle/input</dd></div>
          <div><dt>Platform</dt><dd>{runtime?.platform || 'local'}</dd></div>
        </dl>
        <button className="button secondary full-width" onClick={onRestart} disabled={restarting}>
          {restarting ? <LoaderCircle size={14} className="spin" /> : <RotateCcw size={14} />}
          Restart kernel
        </button>
      </section>

      <section className="inspector-card">
        <div className="inspector-title"><span><Github size={15} /> GitHub</span></div>
        <div className="git-branch-line"><GitBranch size={14} /><span>{runtime?.git.branch || 'Loading…'}</span></div>
        <div className="git-change-count">
          <strong>{runtime?.git.changes.length ?? 0}</strong>
          <span>workspace changes</span>
        </div>
        {runtime?.git.lastCommit && (
          <div className="last-commit">
            <span>Latest commit</span>
            <strong>{runtime.git.lastCommit.hash}</strong>
            <p>{runtime.git.lastCommit.subject}</p>
          </div>
        )}
        <button className="button secondary full-width" onClick={onSync}><Github size={14} /> Sync workspace</button>
      </section>

      <section className="inspector-card persistence-card">
        <div className="inspector-title"><span><HardDrive size={15} /> Persistence</span></div>
        <div className="persistence-flow">
          <div><span>1</span><p>Browser editor</p><CheckCircle2 size={13} /></div>
          <i />
          <div><span>2</span><p>Real project files</p><CheckCircle2 size={13} /></div>
          <i />
          <div><span>3</span><p>GitHub commit</p><Github size={13} /></div>
        </div>
        <p className="inspector-note">Save writes to disk. Commit &amp; push updates GitHub.</p>
      </section>

      <section className="inspector-card compatibility-card">
        <div className="inspector-title"><span><FolderInput size={15} /> Kaggle compatibility</span></div>
        <ul>
          <li>Persistent Python variables</li>
          <li><code>/kaggle/working</code> path mapping</li>
          <li><code>/kaggle/input</code> path mapping</li>
          <li><code>!pip</code>, <code>%pip</code>, <code>%cd</code></li>
        </ul>
      </section>

      <div className="consent-note"><ShieldCheck size={16} /><span>Use voice data only with the speaker’s permission. Disclose generated audio.</span></div>
    </aside>
  );
}
