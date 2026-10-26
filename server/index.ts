import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import express, { type NextFunction, type Request, type Response } from 'express';
import { INPUT_ROOT, KAGGLE_ROOT, PYTHON_BIN, REPO_ROOT, WORKING_ROOT } from './config.ts';
import { HttpError } from './errors.ts';
import {
  createWorkspaceEntry,
  deleteWorkspaceEntry,
  getAbsoluteWorkspacePath,
  listWorkspaceFiles,
  readWorkspaceFile,
  writeWorkspaceFile,
} from './files.ts';
import { getGitStatus, syncWorkspaceToGitHub } from './git.ts';
import { KernelManager } from './kernel.ts';

const execFileAsync = promisify(execFile);
const app = express();
const kernels = new KernelManager();
const portArgument = process.argv.indexOf('--port');
const port = Number(portArgument >= 0 ? process.argv[portArgument + 1] : process.env.PORT || 3000);
const production = process.env.NODE_ENV === 'production';
let gitSyncInProgress = false;

await Promise.all([
  fs.mkdir(WORKING_ROOT, { recursive: true }),
  fs.mkdir(INPUT_ROOT, { recursive: true }),
]);

app.disable('x-powered-by');
app.use(express.json({ limit: '30mb' }));
app.use('/api', (_req, res, next) => {
  res.setHeader('Cache-Control', 'no-store');
  next();
});

const asyncRoute =
  (handler: (req: Request, res: Response, next: NextFunction) => Promise<unknown>) =>
  (req: Request, res: Response, next: NextFunction) => {
    handler(req, res, next).catch(next);
  };

app.get(
  '/api/health',
  asyncRoute(async (_req, res) => {
    res.json({ ok: true, repository: path.basename(REPO_ROOT) });
  }),
);

app.get(
  '/api/runtime',
  asyncRoute(async (_req, res) => {
    let pythonVersion = 'Unavailable';
    let pythonExecutable = PYTHON_BIN;
    try {
      const { stdout } = await execFileAsync(PYTHON_BIN, [
        '-c',
        'import sys; print(sys.version.split()[0]); print(sys.executable)',
      ]);
      const [version, executable] = stdout.trim().split('\n');
      pythonVersion = version;
      pythonExecutable = executable || PYTHON_BIN;
    } catch {
      // The UI reports the unavailable runtime without preventing file editing.
    }
    const git = await getGitStatus();
    res.json({
      pythonVersion,
      pythonExecutable,
      nodeVersion: process.version,
      platform: process.platform,
      repository: path.basename(REPO_ROOT),
      paths: {
        working: '/kaggle/working',
        input: '/kaggle/input',
        realWorking: path.relative(REPO_ROOT, WORKING_ROOT),
        realInput: path.relative(REPO_ROOT, INPUT_ROOT),
      },
      git,
    });
  }),
);

app.get(
  '/api/files',
  asyncRoute(async (_req, res) => {
    res.json({ root: '/kaggle', files: await listWorkspaceFiles() });
  }),
);

app.get(
  '/api/files/content',
  asyncRoute(async (req, res) => {
    res.json(await readWorkspaceFile(String(req.query.path || '')));
  }),
);

app.get(
  '/api/files/raw',
  asyncRoute(async (req, res) => {
    res.sendFile(getAbsoluteWorkspacePath(String(req.query.path || '')));
  }),
);

app.put(
  '/api/files/content',
  asyncRoute(async (req, res) => {
    const { path: filePath, content } = req.body as { path: string; content: string };
    const entry = await writeWorkspaceFile(filePath, content);
    res.json({ entry, message: `Saved ${entry.path} to the repository.` });
  }),
);

app.post(
  '/api/files',
  asyncRoute(async (req, res) => {
    const { path: filePath, kind } = req.body as { path: string; kind: 'file' | 'directory' };
    if (kind !== 'file' && kind !== 'directory') throw new HttpError(400, 'Invalid entry type.');
    const entry = await createWorkspaceEntry(filePath, kind);
    res.status(201).json({ entry });
  }),
);

app.delete(
  '/api/files',
  asyncRoute(async (req, res) => {
    await deleteWorkspaceEntry(String(req.query.path || ''));
    res.json({ ok: true });
  }),
);

app.post(
  '/api/kernels/execute',
  asyncRoute(async (req, res) => {
    const { sessionId, code, cellId } = req.body as {
      sessionId: string;
      code: string;
      cellId?: string;
    };
    res.status(202).json(kernels.execute(sessionId, code, cellId));
  }),
);

app.get('/api/jobs/:jobId', (req, res, next) => {
  try {
    res.json(kernels.getJob(req.params.jobId));
  } catch (error) {
    next(error);
  }
});

app.delete('/api/jobs/:jobId', (req, res, next) => {
  try {
    res.json(kernels.stopJob(req.params.jobId));
  } catch (error) {
    next(error);
  }
});

app.post('/api/kernels/restart', (req, res, next) => {
  try {
    kernels.restart(String(req.body?.sessionId || ''));
    res.json({ ok: true });
  } catch (error) {
    next(error);
  }
});

app.get(
  '/api/git/status',
  asyncRoute(async (_req, res) => {
    res.json(await getGitStatus());
  }),
);

app.post(
  '/api/git/sync',
  asyncRoute(async (req, res) => {
    if (gitSyncInProgress) throw new HttpError(409, 'A GitHub sync is already in progress.');
    gitSyncInProgress = true;
    try {
      res.json(await syncWorkspaceToGitHub(String(req.body?.message || '')));
    } finally {
      gitSyncInProgress = false;
    }
  }),
);

app.use('/api', (_req, res) => {
  res.status(404).json({ error: 'API endpoint not found.' });
});

app.use((error: unknown, _req: Request, res: Response, next: NextFunction) => {
  if (res.headersSent) return next(error);
  const status = error instanceof HttpError ? error.status : (error as { status?: number })?.status || 500;
  const message = error instanceof Error ? error.message : 'Unexpected server error.';
  if (status >= 500) console.error(error);
  res.status(status).json({ error: message });
});

if (production) {
  const distDirectory = path.join(REPO_ROOT, 'dist');
  app.use(express.static(distDirectory));
  app.get('*', (_req, res) => res.sendFile(path.join(distDirectory, 'index.html')));
} else {
  const { createServer: createViteServer } = await import('vite');
  const vite = await createViteServer({
    server: { middlewareMode: true, hmr: false, allowedHosts: true },
    appType: 'spa',
  });
  app.use(vite.middlewares);
}

const server = app.listen(port, '0.0.0.0', () => {
  console.log(`Kaggle Workbench ready at http://0.0.0.0:${port}`);
  console.log(`Real workspace: ${KAGGLE_ROOT}`);
});

function shutdown() {
  kernels.dispose();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 2_000).unref();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
