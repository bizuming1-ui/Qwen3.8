export type CellType = 'code' | 'markdown';
export type OutputName = 'stdout' | 'stderr' | 'result' | 'error' | 'image' | 'audio';

export interface CellOutput {
  name: OutputName;
  text: string;
  mime?: string;
}

export interface NotebookCell {
  id: string;
  cell_type: CellType;
  source: string;
  outputs: CellOutput[];
  execution_count: number | null;
}

export interface NotebookDocument {
  cells: NotebookCell[];
  metadata: Record<string, unknown>;
}

type RawNotebook = {
  cells?: Array<Record<string, unknown>>;
  metadata?: Record<string, unknown>;
};

export function createCellId() {
  return globalThis.crypto?.randomUUID?.() || `cell-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

export function createCell(cell_type: CellType = 'code', source = ''): NotebookCell {
  return { id: createCellId(), cell_type, source, outputs: [], execution_count: null };
}

export function emptyNotebook(): NotebookDocument {
  return {
    cells: [createCell('code', '')],
    metadata: {
      kernelspec: { display_name: 'Python 3', language: 'python', name: 'python3' },
      language_info: { name: 'python', version: '3' },
    },
  };
}

function sourceText(value: unknown) {
  return Array.isArray(value) ? value.join('') : typeof value === 'string' ? value : '';
}

function stripAnsi(value: string) {
  // eslint-disable-next-line no-control-regex
  return value.replace(/\u001b\[[0-9;]*m/g, '');
}

function parseRawOutput(raw: Record<string, unknown>): CellOutput | null {
  const outputType = raw.output_type;
  if (outputType === 'stream') {
    return {
      name: raw.name === 'stderr' ? 'stderr' : 'stdout',
      text: sourceText(raw.text),
    };
  }
  if (outputType === 'error') {
    const traceback = Array.isArray(raw.traceback) ? raw.traceback.join('\n') : '';
    return {
      name: 'error',
      text: stripAnsi(traceback || `${raw.ename || 'Error'}: ${raw.evalue || ''}`),
    };
  }
  if (outputType === 'execute_result' || outputType === 'display_data') {
    const data = (raw.data || {}) as Record<string, unknown>;
    const imageMime = ['image/png', 'image/jpeg', 'image/gif', 'image/svg+xml'].find(
      (mime) => typeof data[mime] === 'string' || Array.isArray(data[mime]),
    );
    if (imageMime) return { name: 'image', text: sourceText(data[imageMime]), mime: imageMime };
    const audioMime = ['audio/wav', 'audio/mpeg', 'audio/ogg'].find(
      (mime) => typeof data[mime] === 'string' || Array.isArray(data[mime]),
    );
    if (audioMime) return { name: 'audio', text: sourceText(data[audioMime]), mime: audioMime };
    return { name: 'result', text: sourceText(data['text/plain']) };
  }
  return null;
}

export function parseNotebook(content: string): NotebookDocument {
  let raw: RawNotebook;
  try {
    raw = JSON.parse(content) as RawNotebook;
  } catch {
    throw new Error('This notebook is not valid JSON.');
  }
  if (!Array.isArray(raw.cells)) throw new Error('This file does not contain valid notebook cells.');

  const cells = raw.cells.map((cell) => {
    const cellType: CellType = cell.cell_type === 'markdown' ? 'markdown' : 'code';
    const rawOutputs = Array.isArray(cell.outputs) ? cell.outputs : [];
    return {
      id: createCellId(),
      cell_type: cellType,
      source: sourceText(cell.source),
      outputs:
        cellType === 'code'
          ? rawOutputs
              .filter((output): output is Record<string, unknown> => Boolean(output && typeof output === 'object'))
              .map(parseRawOutput)
              .filter((output): output is CellOutput => output !== null)
          : [],
      execution_count: typeof cell.execution_count === 'number' ? cell.execution_count : null,
    };
  });

  return {
    cells: cells.length > 0 ? cells : [createCell()],
    metadata: raw.metadata || emptyNotebook().metadata,
  };
}

function serializeOutput(output: CellOutput, executionCount: number | null) {
  if (output.name === 'stdout' || output.name === 'stderr') {
    return {
      output_type: 'stream',
      name: output.name === 'stderr' ? 'stderr' : 'stdout',
      text: output.text,
    };
  }
  if (output.name === 'error') {
    return {
      output_type: 'error',
      ename: 'Error',
      evalue: '',
      traceback: output.text.split('\n'),
    };
  }
  if ((output.name === 'image' || output.name === 'audio') && output.mime) {
    return {
      output_type: 'display_data',
      data: { [output.mime]: output.text },
      metadata: {},
    };
  }
  return {
    output_type: 'execute_result',
    execution_count: executionCount,
    data: { 'text/plain': output.text },
    metadata: {},
  };
}

export function serializeNotebook(notebook: NotebookDocument) {
  return `${JSON.stringify(
    {
      cells: notebook.cells.map((cell) => ({
        id: cell.id,
        cell_type: cell.cell_type,
        execution_count: cell.cell_type === 'code' ? cell.execution_count : undefined,
        metadata: {},
        outputs:
          cell.cell_type === 'code'
            ? cell.outputs.map((output) => serializeOutput(output, cell.execution_count))
            : undefined,
        source: cell.source,
      })),
      metadata: notebook.metadata,
      nbformat: 4,
      nbformat_minor: 5,
    },
    null,
    2,
  )}\n`;
}

export function notebookFromScript(script: string): NotebookDocument {
  const notebook = emptyNotebook();
  const marker = /^# %%([^\r\n]*)$/gm;
  const matches = [...script.matchAll(marker)];
  if (matches.length === 0) {
    notebook.cells = [createCell('code', script)];
    return notebook;
  }

  const cells: NotebookCell[] = [];
  const firstIndex = matches[0].index ?? 0;
  const prefix = script.slice(0, firstIndex).trim();
  if (prefix) cells.push(createCell('code', script.slice(0, firstIndex)));

  matches.forEach((match, index) => {
    const start = (match.index ?? 0) + match[0].length;
    const end = index + 1 < matches.length ? matches[index + 1].index : script.length;
    const isMarkdown = match[1]?.includes('[markdown]') || false;
    let source = script.slice(start, end).replace(/^\r?\n/, '');
    if (isMarkdown) {
      source = source
        .split('\n')
        .map((line) => line.replace(/^\s*# ?/, ''))
        .join('\n');
    }
    cells.push(createCell(isMarkdown ? 'markdown' : 'code', source));
  });
  notebook.cells = cells.length > 0 ? cells : [createCell()];
  return notebook;
}

export function isNotebookPath(path: string) {
  return path.toLowerCase().endsWith('.ipynb');
}

export function languageForPath(path: string) {
  const extension = path.split('.').pop()?.toLowerCase();
  if (extension === 'py' || extension === 'ipynb') return 'python';
  if (extension === 'md' || extension === 'markdown') return 'markdown';
  return 'text';
}
