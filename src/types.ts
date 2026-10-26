export interface WorkspaceEntry {
  name: string;
  path: string;
  type: 'file' | 'directory';
  size: number;
  modifiedAt: string;
}

export type JobStatus = 'queued' | 'running' | 'success' | 'error' | 'cancelled';
export interface JobOutput {
  name: 'stdout' | 'stderr' | 'result' | 'error';
  text: string;
}

export interface ExecutionJob {
  id: string;
  cellId?: string;
  status: JobStatus;
  outputs: JobOutput[];
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
  durationMs?: number;
}

export interface GitStatus {
  branch: string;
  changes: string[];
  lastCommit: null | {
    hash: string;
    subject: string;
    committedAt: string;
  };
}

export interface RuntimeInfo {
  pythonVersion: string;
  pythonExecutable: string;
  nodeVersion: string;
  platform: string;
  repository: string;
  paths: {
    working: string;
    input: string;
    realWorking: string;
    realInput: string;
  };
  git: GitStatus;
}

export interface GitSyncResult {
  status: 'committed' | 'unchanged';
  branch: string;
  hash?: string;
  message: string;
  output: string;
}
