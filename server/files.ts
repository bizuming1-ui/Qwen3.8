import { promises as fs } from 'node:fs';
import path from 'node:path';
import { KAGGLE_ROOT, MAX_TEXT_FILE_BYTES } from './config.ts';
import { HttpError } from './errors.ts';

export interface WorkspaceEntry {
  name: string;
  path: string;
  type: 'file' | 'directory';
  size: number;
  modifiedAt: string;
}

interface ResolvedWorkspacePath {
  absolutePath: string;
  relativePath: string;
}

const SKIPPED_DIRECTORIES = new Set([
  '__pycache__',
  '.ipynb_checkpoints',
  '.pytest_cache',
  '.mypy_cache',
]);

export function resolveWorkspacePath(input: string): ResolvedWorkspacePath {
  if (!input || typeof input !== 'string' || input.includes('\0')) {
    throw new HttpError(400, 'A valid workspace path is required.');
  }

  const normalizedInput = input
    .replaceAll('\\', '/')
    .replace(/^\/+/, '')
    .replace(/^kaggle\//, '');
  const absolutePath = path.resolve(KAGGLE_ROOT, normalizedInput);
  const rootPrefix = `${KAGGLE_ROOT}${path.sep}`;

  if (absolutePath === KAGGLE_ROOT || !absolutePath.startsWith(rootPrefix)) {
    throw new HttpError(400, 'Paths must stay inside the kaggle workspace.');
  }

  const relativePath = path.relative(KAGGLE_ROOT, absolutePath).split(path.sep).join('/');
  if (relativePath.split('/').some((part) => part === '..' || part === '.git')) {
    throw new HttpError(400, 'This path is not allowed.');
  }

  return { absolutePath, relativePath };
}

async function toEntry(absolutePath: string, name: string, type: 'file' | 'directory') {
  const stat = await fs.stat(absolutePath);
  return {
    name,
    path: path.relative(KAGGLE_ROOT, absolutePath).split(path.sep).join('/'),
    type,
    size: type === 'file' ? stat.size : 0,
    modifiedAt: stat.mtime.toISOString(),
  } satisfies WorkspaceEntry;
}

export async function listWorkspaceFiles(): Promise<WorkspaceEntry[]> {
  const entries: WorkspaceEntry[] = [];
  let visited = 0;

  async function walk(directory: string, depth: number) {
    if (depth > 8 || visited > 2_000) return;
    const children = await fs.readdir(directory, { withFileTypes: true });
    children.sort((a, b) => {
      if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1;
      return a.name.localeCompare(b.name);
    });

    for (const child of children) {
      if (child.name === '.gitkeep' || SKIPPED_DIRECTORIES.has(child.name)) continue;
      if (child.isSymbolicLink()) continue;
      if (!child.isDirectory() && !child.isFile()) continue;
      visited += 1;
      const absolutePath = path.join(directory, child.name);
      const type = child.isDirectory() ? 'directory' : 'file';
      entries.push(await toEntry(absolutePath, child.name, type));
      if (child.isDirectory()) await walk(absolutePath, depth + 1);
    }
  }

  await walk(KAGGLE_ROOT, 0);
  return entries;
}

export async function readWorkspaceFile(inputPath: string) {
  const { absolutePath, relativePath } = resolveWorkspacePath(inputPath);
  let stat;
  try {
    stat = await fs.stat(absolutePath);
  } catch {
    throw new HttpError(404, `File not found: ${relativePath}`);
  }
  if (!stat.isFile()) throw new HttpError(400, 'The selected path is not a file.');
  if (stat.size > MAX_TEXT_FILE_BYTES) {
    throw new HttpError(413, 'This file is too large for the browser editor (12 MB limit).');
  }

  const content = await fs.readFile(absolutePath);
  if (content.subarray(0, 8_000).includes(0)) {
    throw new HttpError(415, 'Binary files can be downloaded, but not edited as text.');
  }

  return {
    path: relativePath,
    content: content.toString('utf8'),
    size: stat.size,
    modifiedAt: stat.mtime.toISOString(),
  };
}

export async function writeWorkspaceFile(inputPath: string, content: string) {
  const { absolutePath, relativePath } = resolveWorkspacePath(inputPath);
  if (typeof content !== 'string') throw new HttpError(400, 'File content must be text.');
  if (Buffer.byteLength(content, 'utf8') > MAX_TEXT_FILE_BYTES) {
    throw new HttpError(413, 'This file exceeds the 12 MB editor limit.');
  }

  await fs.mkdir(path.dirname(absolutePath), { recursive: true });
  const temporaryPath = `${absolutePath}.${process.pid}.tmp`;
  await fs.writeFile(temporaryPath, content, 'utf8');
  await fs.rename(temporaryPath, absolutePath);
  return toEntry(absolutePath, path.basename(absolutePath), 'file');
}

export async function createWorkspaceEntry(inputPath: string, kind: 'file' | 'directory') {
  const { absolutePath } = resolveWorkspacePath(inputPath);
  if (kind === 'directory') {
    await fs.mkdir(absolutePath, { recursive: false });
    return toEntry(absolutePath, path.basename(absolutePath), 'directory');
  }

  await fs.mkdir(path.dirname(absolutePath), { recursive: true });
  try {
    await fs.writeFile(absolutePath, '', { encoding: 'utf8', flag: 'wx' });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
      throw new HttpError(409, 'A file or folder already exists at this path.');
    }
    throw error;
  }
  return toEntry(absolutePath, path.basename(absolutePath), 'file');
}

export async function deleteWorkspaceEntry(inputPath: string) {
  const { absolutePath, relativePath } = resolveWorkspacePath(inputPath);
  if (relativePath === 'working' || relativePath === 'input') {
    throw new HttpError(400, 'The working and input folders cannot be deleted.');
  }
  await fs.rm(absolutePath, { recursive: true, force: false });
}

export function getAbsoluteWorkspacePath(inputPath: string) {
  return resolveWorkspacePath(inputPath).absolutePath;
}
