import { describe, expect, it } from 'vitest';
import { notebookFromScript, parseNotebook, serializeNotebook } from './notebook';

describe('notebook conversion', () => {
  it('imports a plain Python script as one executable cell', () => {
    const notebook = notebookFromScript('print("hello")\n');
    expect(notebook.cells).toHaveLength(1);
    expect(notebook.cells[0].cell_type).toBe('code');
    expect(notebook.cells[0].source).toBe('print("hello")\n');
  });

  it('splits script cell markers and markdown sections', () => {
    const notebook = notebookFromScript('# %%\na = 1\n# %% [markdown]\n# Title\n# %%\na + 1\n');
    expect(notebook.cells.map((cell) => cell.cell_type)).toEqual(['code', 'markdown', 'code']);
    expect(notebook.cells[1].source).toBe('Title\n');
  });

  it('round-trips source and stream outputs', () => {
    const original = notebookFromScript('print("persisted")');
    original.cells[0].outputs = [{ name: 'stdout', text: 'persisted\n' }];
    original.cells[0].execution_count = 1;
    const restored = parseNotebook(serializeNotebook(original));
    expect(restored.cells[0].source).toBe('print("persisted")');
    expect(restored.cells[0].outputs[0]).toEqual({ name: 'stdout', text: 'persisted\n' });
    expect(restored.cells[0].execution_count).toBe(1);
  });

  it('rejects invalid notebook JSON with a useful error', () => {
    expect(() => parseNotebook('{broken')).toThrow('not valid JSON');
  });
});
