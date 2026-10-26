import path from 'node:path';
import { fileURLToPath } from 'node:url';

const serverDirectory = path.dirname(fileURLToPath(import.meta.url));

export const REPO_ROOT = path.resolve(serverDirectory, '..');
export const KAGGLE_ROOT = path.join(REPO_ROOT, 'kaggle');
export const WORKING_ROOT = path.join(KAGGLE_ROOT, 'working');
export const INPUT_ROOT = path.join(KAGGLE_ROOT, 'input');
export const PYTHON_BIN = process.env.PYTHON_BIN || 'python3';
export const MAX_TEXT_FILE_BYTES = 12 * 1024 * 1024;
export const MAX_OUTPUT_CHARS = 1_000_000;
