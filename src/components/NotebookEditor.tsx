import { useState } from 'react';
import CodeMirror from '@uiw/react-codemirror';
import { python } from '@codemirror/lang-python';
import { markdown } from '@codemirror/lang-markdown';
import { oneDark } from '@codemirror/theme-one-dark';
import ReactMarkdown from 'react-markdown';
import {
  ArrowDown,
  ArrowUp,
  Code2,
  Eye,
  FilePlus2,
  LoaderCircle,
  Pencil,
  Play,
  Plus,
  Square,
  Trash2,
  Type,
} from 'lucide-react';
import type { CellType, NotebookDocument } from '../lib/notebook';
import { OutputView } from './OutputView';

interface NotebookEditorProps {
  notebook: NotebookDocument;
  runningCells: Set<string>;
  onCellChange: (cellId: string, source: string) => void;
  onCellTypeChange: (cellId: string, type: CellType) => void;
  onAddCell: (type: CellType, index?: number) => void;
  onDeleteCell: (cellId: string) => void;
  onMoveCell: (cellId: string, direction: -1 | 1) => void;
  onRunCell: (cellId: string) => void;
  onStopCell: (cellId: string) => void;
}

export function NotebookEditor({
  notebook,
  runningCells,
  onCellChange,
  onCellTypeChange,
  onAddCell,
  onDeleteCell,
  onMoveCell,
  onRunCell,
  onStopCell,
}: NotebookEditorProps) {
  const [editingMarkdown, setEditingMarkdown] = useState<Set<string>>(new Set());

  const toggleMarkdown = (cellId: string) => {
    setEditingMarkdown((current) => {
      const next = new Set(current);
      if (next.has(cellId)) next.delete(cellId);
      else next.add(cellId);
      return next;
    });
  };

  return (
    <div className="notebook-editor">
      {notebook.cells.map((cell, index) => {
        const running = runningCells.has(cell.id);
        const isMarkdownEditing = cell.source.length === 0 || editingMarkdown.has(cell.id);
        return (
          <article className={`notebook-cell ${running ? 'cell-running' : ''}`} key={cell.id}>
            <div className="cell-gutter">
              {cell.cell_type === 'code' ? (
                <button
                  className={`run-cell-button ${running ? 'stop' : ''}`}
                  onClick={() => (running ? onStopCell(cell.id) : onRunCell(cell.id))}
                  title={running ? 'Stop this cell' : 'Run this cell'}
                  aria-label={running ? 'Stop this cell' : 'Run this cell'}
                >
                  {running ? <Square size={13} fill="currentColor" /> : <Play size={15} fill="currentColor" />}
                </button>
              ) : (
                <span className="markdown-gutter"><Type size={15} /></span>
              )}
              <span className="execution-count">
                {cell.cell_type === 'code' ? `[${running ? '*' : cell.execution_count ?? ' '}]` : ''}
              </span>
            </div>
            <div className="cell-main">
              <div className="cell-toolbar">
                <span className={`cell-kind ${cell.cell_type}`}>
                  {cell.cell_type === 'code' ? <Code2 size={13} /> : <Type size={13} />}
                  {cell.cell_type === 'code' ? 'Python' : 'Markdown'}
                </span>
                <div className="cell-toolbar-actions">
                  {cell.cell_type === 'markdown' && (
                    <button className="icon-button" onClick={() => toggleMarkdown(cell.id)} title={isMarkdownEditing ? 'Preview Markdown' : 'Edit Markdown'}>
                      {isMarkdownEditing ? <Eye size={14} /> : <Pencil size={14} />}
                    </button>
                  )}
                  <select
                    aria-label="Cell type"
                    value={cell.cell_type}
                    onChange={(event) => onCellTypeChange(cell.id, event.target.value as CellType)}
                  >
                    <option value="code">Code</option>
                    <option value="markdown">Markdown</option>
                  </select>
                  <button className="icon-button" disabled={index === 0} onClick={() => onMoveCell(cell.id, -1)} title="Move cell up"><ArrowUp size={14} /></button>
                  <button className="icon-button" disabled={index === notebook.cells.length - 1} onClick={() => onMoveCell(cell.id, 1)} title="Move cell down"><ArrowDown size={14} /></button>
                  <button className="icon-button danger" onClick={() => onDeleteCell(cell.id)} title="Delete cell"><Trash2 size={14} /></button>
                </div>
              </div>

              {cell.cell_type === 'markdown' && !isMarkdownEditing ? (
                <div className="markdown-preview" onDoubleClick={() => toggleMarkdown(cell.id)}>
                  <ReactMarkdown>{cell.source}</ReactMarkdown>
                </div>
              ) : (
                <CodeMirror
                  value={cell.source}
                  onChange={(value) => onCellChange(cell.id, value)}
                  extensions={cell.cell_type === 'code' ? [python()] : [markdown()]}
                  theme={oneDark}
                  minHeight={cell.cell_type === 'code' ? '76px' : '58px'}
                  basicSetup={{
                    lineNumbers: cell.cell_type === 'code',
                    foldGutter: cell.cell_type === 'code',
                    highlightActiveLine: true,
                    highlightActiveLineGutter: cell.cell_type === 'code',
                  }}
                  placeholder={cell.cell_type === 'code' ? 'Write Python code…' : 'Write Markdown…'}
                />
              )}

              {cell.cell_type === 'code' && (cell.outputs.length > 0 || running) && (
                <OutputView outputs={cell.outputs} running={running && cell.outputs.length === 0} />
              )}
            </div>
          </article>
        );
      })}

      <div className="add-cell-bar">
        <button onClick={() => onAddCell('code')}><Plus size={14} /><Code2 size={14} /> Code</button>
        <span />
        <button onClick={() => onAddCell('markdown')}><Plus size={14} /><Type size={14} /> Markdown</button>
      </div>
      <div className="notebook-end">
        <FilePlus2 size={14} /> {notebook.cells.length} cells · Saved as Jupyter nbformat 4
        {runningCells.size > 0 && <LoaderCircle size={14} className="spin" />}
      </div>
    </div>
  );
}
