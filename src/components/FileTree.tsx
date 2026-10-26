import { useState, type ReactNode } from 'react';
import {
  ChevronDown,
  ChevronRight,
  File,
  FileAudio,
  FileCode2,
  FileJson2,
  FileText,
  Folder,
  FolderOpen,
  Import,
  Plus,
  RefreshCw,
  Trash2,
} from 'lucide-react';
import type { WorkspaceEntry } from '../types';

interface FileTreeProps {
  entries: WorkspaceEntry[];
  selectedPath: string;
  loading: boolean;
  onSelect: (entry: WorkspaceEntry) => void;
  onCreate: () => void;
  onImport: () => void;
  onRefresh: () => void;
  onDelete: (entry: WorkspaceEntry) => void;
}

function fileIcon(entry: WorkspaceEntry) {
  const extension = entry.name.split('.').pop()?.toLowerCase();
  if (extension === 'py' || extension === 'ipynb') return <FileCode2 size={15} />;
  if (extension === 'json' || extension === 'yaml' || extension === 'yml') return <FileJson2 size={15} />;
  if (['wav', 'mp3', 'flac', 'ogg'].includes(extension || '')) return <FileAudio size={15} />;
  if (['md', 'txt', 'csv'].includes(extension || '')) return <FileText size={15} />;
  return <File size={15} />;
}

export function FileTree({
  entries,
  selectedPath,
  loading,
  onSelect,
  onCreate,
  onImport,
  onRefresh,
  onDelete,
}: FileTreeProps) {
  const [expanded, setExpanded] = useState(() => new Set(['working', 'input']));
  const roots = entries.filter((entry) => !entry.path.includes('/'));
  const childrenOf = (entry: WorkspaceEntry) =>
    entries.filter((candidate) => {
      const prefix = `${entry.path}/`;
      if (!candidate.path.startsWith(prefix)) return false;
      return !candidate.path.slice(prefix.length).includes('/');
    });

  const toggle = (path: string) => {
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  };

  const renderEntry = (entry: WorkspaceEntry, depth: number): ReactNode => {
    const isDirectory = entry.type === 'directory';
    const isExpanded = expanded.has(entry.path);
    const children = isDirectory ? childrenOf(entry) : [];
    return (
      <div key={entry.path}>
        <div
          className={`file-row ${selectedPath === entry.path ? 'selected' : ''}`}
          style={{ paddingLeft: `${10 + depth * 15}px` }}
        >
          <button
            className="file-row-main"
            onClick={() => (isDirectory ? toggle(entry.path) : onSelect(entry))}
            title={`/kaggle/${entry.path}`}
          >
            <span className="file-chevron">
              {isDirectory ? (
                isExpanded ? <ChevronDown size={13} /> : <ChevronRight size={13} />
              ) : null}
            </span>
            <span className="file-icon">
              {isDirectory ? (
                isExpanded ? <FolderOpen size={15} /> : <Folder size={15} />
              ) : (
                fileIcon(entry)
              )}
            </span>
            <span className="file-name">{entry.name}</span>
          </button>
          {!isDirectory || entry.path.includes('/') ? (
            <button
              className="file-delete"
              onClick={() => onDelete(entry)}
              aria-label={`Delete ${entry.name}`}
              title="Delete from repository"
            >
              <Trash2 size={13} />
            </button>
          ) : null}
        </div>
        {isDirectory && isExpanded && children.map((child) => renderEntry(child, depth + 1))}
      </div>
    );
  };

  return (
    <aside className="file-sidebar">
      <div className="sidebar-heading">
        <div>
          <span className="eyebrow">REPOSITORY</span>
          <h2>Files</h2>
        </div>
        <div className="sidebar-actions">
          <button className="icon-button" onClick={onCreate} title="New file or folder">
            <Plus size={17} />
          </button>
          <button className="icon-button" onClick={onImport} title="Import Kaggle code">
            <Import size={16} />
          </button>
          <button className="icon-button" onClick={onRefresh} title="Refresh files">
            <RefreshCw size={15} className={loading ? 'spin' : ''} />
          </button>
        </div>
      </div>
      <div className="workspace-root">
        <span>/kaggle</span>
        <span className="local-badge">LOCAL</span>
      </div>
      <nav className="file-tree" aria-label="Repository workspace files">
        {roots.map((entry) => renderEntry(entry, 0))}
        {entries.length === 0 && !loading && <p className="muted file-empty">No workspace files yet.</p>}
      </nav>
      <div className="sidebar-storage">
        <HardDriveIcon />
        <div>
          <strong>Real disk storage</strong>
          <span>Changes are written to this Git repository, not browser storage.</span>
        </div>
      </div>
    </aside>
  );
}

function HardDriveIcon() {
  return (
    <span className="storage-icon" aria-hidden="true">
      <span />
      <span />
    </span>
  );
}
