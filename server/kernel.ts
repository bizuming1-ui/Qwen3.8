import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import { INPUT_ROOT, MAX_OUTPUT_CHARS, PYTHON_BIN, WORKING_ROOT } from './config.ts';
import { HttpError } from './errors.ts';

export type JobStatus = 'queued' | 'running' | 'success' | 'error' | 'cancelled';
export interface JobOutput {
  name: 'stdout' | 'stderr' | 'result' | 'error';
  text: string;
}

interface ExecutionJob {
  id: string;
  cellId?: string;
  sessionId: string;
  code: string;
  status: JobStatus;
  outputs: JobOutput[];
  outputChars: number;
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
  durationMs?: number;
  timer?: NodeJS.Timeout;
}

const pythonKernelPath = path.join(path.dirname(fileURLToPath(import.meta.url)), 'python_kernel.py');
const executionTimeout = Number(process.env.EXECUTION_TIMEOUT_MS || 10 * 60 * 1000);

function publicJob(job: ExecutionJob) {
  return {
    id: job.id,
    cellId: job.cellId,
    status: job.status,
    outputs: job.outputs,
    createdAt: job.createdAt,
    startedAt: job.startedAt,
    finishedAt: job.finishedAt,
    durationMs: job.durationMs,
  };
}

class KernelSession {
  private child?: ChildProcessWithoutNullStreams;
  private current?: ExecutionJob;
  private queue: ExecutionJob[] = [];

  constructor(public readonly id: string) {
    this.start();
  }

  private start() {
    const child = spawn(PYTHON_BIN, ['-u', pythonKernelPath], {
      cwd: WORKING_ROOT,
      env: {
        ...process.env,
        KAGGLE_WORKING_DIR: WORKING_ROOT,
        KAGGLE_INPUT_DIR: INPUT_ROOT,
        PYTHONUNBUFFERED: '1',
        PYTHONDONTWRITEBYTECODE: '1',
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.child = child;

    const lines = readline.createInterface({ input: child.stdout });
    lines.on('line', (line) => {
      try {
        this.handleEvent(JSON.parse(line));
      } catch {
        if (this.current) this.appendOutput(this.current, 'stderr', `${line}\n`);
      }
    });
    child.stderr.on('data', (chunk: Buffer) => {
      if (this.current) this.appendOutput(this.current, 'stderr', chunk.toString());
    });
    // A killed kernel can close stdin while a request is being written. Handle
    // the stream error so it never becomes an uncaught Node.js exception.
    child.stdin.on('error', (error) => {
      if (this.child === child && this.current) {
        this.appendOutput(this.current, 'stderr', `Python stdin closed: ${error.message}`);
      }
    });
    child.on('error', (error) => {
      if (this.child === child) this.child = undefined;
      if (this.current) {
        this.appendOutput(this.current, 'error', `Unable to start Python: ${error.message}`);
        this.finishCurrent('error');
      }
    });
    child.on('exit', (code, signal) => {
      lines.close();
      if (this.child !== child) return;
      this.child = undefined;
      if (this.current) {
        this.appendOutput(
          this.current,
          'error',
          `Python kernel stopped (code=${code ?? 'none'}, signal=${signal ?? 'none'}). Restart or run again.`,
        );
        this.finishCurrent('error');
      }
    });
  }

  private appendOutput(job: ExecutionJob, name: JobOutput['name'], text: string) {
    if (!text || job.outputChars >= MAX_OUTPUT_CHARS) return;
    const remaining = MAX_OUTPUT_CHARS - job.outputChars;
    const clipped = text.length > remaining ? `${text.slice(0, remaining)}\n[output truncated]` : text;
    const previous = job.outputs.at(-1);
    if (previous?.name === name) previous.text += clipped;
    else job.outputs.push({ name, text: clipped });
    job.outputChars += clipped.length;
  }

  private handleEvent(event: { type?: string; jobId?: string; [key: string]: unknown }) {
    const job = this.current;
    if (!job || event.jobId !== job.id) return;

    if (event.type === 'stream') {
      const name = event.name === 'stderr' ? 'stderr' : 'stdout';
      this.appendOutput(job, name, String(event.text || ''));
    } else if (event.type === 'result') {
      this.appendOutput(job, 'result', String(event.text || ''));
    } else if (event.type === 'error') {
      this.appendOutput(job, 'error', String(event.text || ''));
    } else if (event.type === 'done') {
      job.durationMs = Number(event.durationMs || 0);
      this.finishCurrent(event.status === 'success' ? 'success' : 'error');
    }
  }

  private finishCurrent(status: JobStatus) {
    if (!this.current) return;
    clearTimeout(this.current.timer);
    this.current.status = status;
    this.current.finishedAt = new Date().toISOString();
    this.current = undefined;
    this.pump();
  }

  private pump() {
    if (this.current || this.queue.length === 0) return;
    if (!this.child || this.child.killed) this.start();
    const job = this.queue.shift()!;
    this.current = job;
    job.status = 'running';
    job.startedAt = new Date().toISOString();
    job.timer = setTimeout(() => {
      if (this.current?.id !== job.id) return;
      this.appendOutput(job, 'error', `Execution exceeded ${Math.round(executionTimeout / 1000)} seconds.`);
      this.stopJob(job.id, 'error');
    }, executionTimeout);

    this.child!.stdin.write(`${JSON.stringify({ type: 'execute', jobId: job.id, code: job.code })}\n`);
  }

  enqueue(job: ExecutionJob) {
    this.queue.push(job);
    this.pump();
  }

  stopJob(jobId: string, status: 'cancelled' | 'error' = 'cancelled') {
    const queuedIndex = this.queue.findIndex((job) => job.id === jobId);
    if (queuedIndex >= 0) {
      const [job] = this.queue.splice(queuedIndex, 1);
      job.status = 'cancelled';
      job.finishedAt = new Date().toISOString();
      return;
    }
    if (this.current?.id !== jobId) return;

    const job = this.current;
    clearTimeout(job.timer);
    job.status = status;
    job.finishedAt = new Date().toISOString();
    this.current = undefined;
    const child = this.child;
    this.child = undefined;
    child?.kill('SIGKILL');
    this.pump();
  }

  restart() {
    for (const job of this.queue) {
      job.status = 'cancelled';
      job.finishedAt = new Date().toISOString();
    }
    this.queue = [];
    if (this.current) {
      clearTimeout(this.current.timer);
      this.current.status = 'cancelled';
      this.current.finishedAt = new Date().toISOString();
      this.current = undefined;
    }
    const child = this.child;
    this.child = undefined;
    child?.kill('SIGKILL');
    this.start();
  }

  dispose() {
    const child = this.child;
    this.child = undefined;
    child?.kill('SIGKILL');
  }
}

export class KernelManager {
  private sessions = new Map<string, KernelSession>();
  private jobs = new Map<string, ExecutionJob>();

  execute(sessionId: string, code: string, cellId?: string) {
    if (!/^[a-zA-Z0-9-]{8,64}$/.test(sessionId)) {
      throw new HttpError(400, 'A valid browser session id is required.');
    }
    if (typeof code !== 'string' || code.length > 2_000_000) {
      throw new HttpError(400, 'Code must be text smaller than 2 MB.');
    }
    let session = this.sessions.get(sessionId);
    if (!session) {
      session = new KernelSession(sessionId);
      this.sessions.set(sessionId, session);
    }
    const job: ExecutionJob = {
      id: randomUUID(),
      cellId,
      sessionId,
      code,
      status: 'queued',
      outputs: [],
      outputChars: 0,
      createdAt: new Date().toISOString(),
    };
    this.jobs.set(job.id, job);
    session.enqueue(job);
    if (this.jobs.size > 500) {
      const oldest = this.jobs.keys().next().value;
      if (oldest && !['queued', 'running'].includes(this.jobs.get(oldest)?.status || '')) {
        this.jobs.delete(oldest);
      }
    }
    return publicJob(job);
  }

  getJob(jobId: string) {
    const job = this.jobs.get(jobId);
    if (!job) throw new HttpError(404, 'Execution job not found.');
    return publicJob(job);
  }

  stopJob(jobId: string) {
    const job = this.jobs.get(jobId);
    if (!job) throw new HttpError(404, 'Execution job not found.');
    this.sessions.get(job.sessionId)?.stopJob(jobId);
    return publicJob(job);
  }

  restart(sessionId: string) {
    if (!/^[a-zA-Z0-9-]{8,64}$/.test(sessionId)) {
      throw new HttpError(400, 'A valid browser session id is required.');
    }
    const session = this.sessions.get(sessionId);
    if (session) session.restart();
    else this.sessions.set(sessionId, new KernelSession(sessionId));
  }

  dispose() {
    for (const session of this.sessions.values()) session.dispose();
    this.sessions.clear();
  }
}
