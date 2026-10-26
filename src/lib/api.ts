import type {
  ExecutionJob,
  GitStatus,
  GitSyncResult,
  RuntimeInfo,
  WorkspaceEntry,
} from '../types';

async function request<T>(url: string, options?: RequestInit): Promise<T> {
  const response = await fetch(url, {
    ...options,
    headers: {
      ...(options?.body ? { 'Content-Type': 'application/json' } : {}),
      ...options?.headers,
    },
  });
  const data = (await response.json().catch(() => ({}))) as { error?: string };
  if (!response.ok) throw new Error(data.error || `Request failed (${response.status}).`);
  return data as T;
}

export const api = {
  runtime: () => request<RuntimeInfo>('/api/runtime'),
  files: () => request<{ root: string; files: WorkspaceEntry[] }>('/api/files'),
  readFile: (path: string) =>
    request<{ path: string; content: string; size: number; modifiedAt: string }>(
      `/api/files/content?path=${encodeURIComponent(path)}`,
    ),
  writeFile: (path: string, content: string) =>
    request<{ entry: WorkspaceEntry; message: string }>('/api/files/content', {
      method: 'PUT',
      body: JSON.stringify({ path, content }),
    }),
  createEntry: (path: string, kind: 'file' | 'directory') =>
    request<{ entry: WorkspaceEntry }>('/api/files', {
      method: 'POST',
      body: JSON.stringify({ path, kind }),
    }),
  deleteEntry: (path: string) =>
    request<{ ok: boolean }>(`/api/files?path=${encodeURIComponent(path)}`, { method: 'DELETE' }),
  execute: (sessionId: string, code: string, cellId?: string) =>
    request<ExecutionJob>('/api/kernels/execute', {
      method: 'POST',
      body: JSON.stringify({ sessionId, code, cellId }),
    }),
  job: (jobId: string) => request<ExecutionJob>(`/api/jobs/${jobId}`),
  stopJob: (jobId: string) => request<ExecutionJob>(`/api/jobs/${jobId}`, { method: 'DELETE' }),
  restartKernel: (sessionId: string) =>
    request<{ ok: boolean }>('/api/kernels/restart', {
      method: 'POST',
      body: JSON.stringify({ sessionId }),
    }),
  gitStatus: () => request<GitStatus>('/api/git/status'),
  gitSync: (message: string) =>
    request<GitSyncResult>('/api/git/sync', {
      method: 'POST',
      body: JSON.stringify({ message }),
    }),
};
