import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { REPO_ROOT } from './config.ts';
import { HttpError } from './errors.ts';

const execFileAsync = promisify(execFile);
const gitEnvironment = { ...process.env, GIT_TERMINAL_PROMPT: '0' };

async function git(args: string[], allowedExitCodes: number[] = [0]) {
  try {
    const { stdout, stderr } = await execFileAsync('git', args, {
      cwd: REPO_ROOT,
      env: gitEnvironment,
      maxBuffer: 4 * 1024 * 1024,
    });
    return { stdout: stdout.trim(), stderr: stderr.trim(), exitCode: 0 };
  } catch (error) {
    const failure = error as NodeJS.ErrnoException & {
      code?: number | string;
      stdout?: string;
      stderr?: string;
    };
    if (typeof failure.code === 'number' && allowedExitCodes.includes(failure.code)) {
      return {
        stdout: failure.stdout?.trim() || '',
        stderr: failure.stderr?.trim() || '',
        exitCode: failure.code,
      };
    }
    throw new HttpError(
      500,
      `Git command failed: ${failure.stderr?.trim() || failure.message || 'unknown error'}`,
    );
  }
}

export async function getGitStatus() {
  const [{ stdout: branch }, { stdout: changes }, { stdout: lastCommit }] = await Promise.all([
    git(['branch', '--show-current']),
    git(['status', '--short', '--untracked-files=all', '--', 'kaggle/working']),
    git(['log', '-1', '--format=%h%x09%s%x09%cI']),
  ]);

  return {
    branch: branch || 'detached HEAD',
    changes: changes ? changes.split('\n').filter(Boolean) : [],
    lastCommit: lastCommit
      ? (() => {
          const [hash, subject, committedAt] = lastCommit.split('\t');
          return { hash, subject, committedAt };
        })()
      : null,
  };
}

export async function syncWorkspaceToGitHub(message: string) {
  const cleanMessage = message.replace(/[\r\n\0]/g, ' ').trim().slice(0, 200);
  if (!cleanMessage) throw new HttpError(400, 'A commit message is required.');

  const { stdout: branch } = await git(['branch', '--show-current']);
  if (!branch) throw new HttpError(409, 'Cannot push from a detached HEAD.');
  const { stdout: remote } = await git(['remote']);
  if (!remote.split('\n').includes('origin')) {
    throw new HttpError(409, 'The origin remote is not configured.');
  }

  await git(['add', '--', 'kaggle/working']);
  const { exitCode } = await git(['diff', '--cached', '--quiet', '--', 'kaggle/working'], [0, 1]);

  if (exitCode === 0) {
    const { stdout, stderr } = await git(['push', 'origin', branch]);
    return {
      status: 'unchanged' as const,
      branch,
      message: 'No new workspace changes. GitHub is already up to date.',
      output: stdout || stderr,
    };
  }

  const { stdout: stagedFiles } = await git(['diff', '--cached', '--name-only']);
  const outsideWorkspace = stagedFiles
    .split('\n')
    .filter(Boolean)
    .filter((file) => !file.startsWith('kaggle/working/'));
  if (outsideWorkspace.length > 0) {
    throw new HttpError(
      409,
      `Other files are already staged. Commit or unstage them first: ${outsideWorkspace.join(', ')}`,
    );
  }

  await git([
    '-c',
    `user.name=${process.env.GIT_AUTHOR_NAME || 'Kaggle Workbench'}`,
    '-c',
    `user.email=${process.env.GIT_AUTHOR_EMAIL || 'kaggle-workbench@localhost'}`,
    'commit',
    '-m',
    cleanMessage,
    '--',
    'kaggle/working',
  ]);
  const { stdout: hash } = await git(['rev-parse', '--short', 'HEAD']);
  const { stdout, stderr } = await git(['push', 'origin', branch]);

  return {
    status: 'committed' as const,
    branch,
    hash,
    message: cleanMessage,
    output: stdout || stderr,
  };
}
