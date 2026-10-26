import { describe, expect, it } from 'vitest';
import { resolveWorkspacePath } from './files';

describe('workspace path safety', () => {
  it('accepts Kaggle-style absolute paths', () => {
    expect(resolveWorkspacePath('/kaggle/working/train.py').relativePath).toBe('working/train.py');
  });

  it('accepts paths relative to the workspace', () => {
    expect(resolveWorkspacePath('input/audio/sample.txt').relativePath).toBe('input/audio/sample.txt');
  });

  it('rejects traversal outside the repository workspace', () => {
    expect(() => resolveWorkspacePath('working/../../package.json')).toThrow('inside the kaggle workspace');
  });

  it('rejects empty paths', () => {
    expect(() => resolveWorkspacePath('')).toThrow('valid workspace path');
  });
});
