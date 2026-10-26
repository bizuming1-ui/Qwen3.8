#!/usr/bin/env node
/**
 * import-kaggle.mjs — 把真实的 Kaggle notebook / 脚本导入项目
 *
 * 用法：
 *   node scripts/import-kaggle.mjs kaggle/voice_clone.ipynb
 *   npm run import:kaggle -- ./your_notebook.ipynb
 *
 * 做的事：
 *   1. 把源文件复制进 kaggle/（原始文件完整保留，进 Git）
 *   2. 解析单元格 → 生成 src/kaggle-code.js（模拟器默认加载的内容）
 *   3. 打印统计
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseNotebookText, summarize } from '../src/ipynb.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const KAGGLE_DIR = path.join(ROOT, 'kaggle');
const OUT = path.join(ROOT, 'src', 'kaggle-code.js');

const arg = process.argv[2];
if (!arg) {
  console.error('用法: node scripts/import-kaggle.mjs <file.ipynb | file.py | file.txt>');
  process.exit(1);
}

const srcPath = path.resolve(process.cwd(), arg);
if (!fs.existsSync(srcPath)) {
  console.error(`✗ 找不到文件: ${srcPath}`);
  process.exit(1);
}

fs.mkdirSync(KAGGLE_DIR, { recursive: true });
const base = path.basename(srcPath);
const destPath = path.join(KAGGLE_DIR, base);
if (path.resolve(destPath) !== srcPath) {
  fs.copyFileSync(srcPath, destPath);
  console.log(`✓ 已复制源文件 → kaggle/${base}`);
} else {
  console.log(`✓ 源文件已在 kaggle/${base}`);
}

const text = fs.readFileSync(destPath, 'utf8');
let parsed;
try {
  parsed = parseNotebookText(text, base);
} catch (e) {
  console.error('✗ 解析失败:', e.message);
  process.exit(1);
}

const { cells, meta } = parsed;
const stat = summarize(cells);
if (!stat.total) {
  console.error('✗ 没有解析到任何单元格');
  process.exit(1);
}

const relName = `kaggle/${base}`;
const banner = `/**
 * kaggle-code.js — 由 scripts/import-kaggle.mjs 自动生成，请不要手改。
 * 源文件：${relName}
 * 导入时间：${new Date().toISOString()}
 * 单元格：${stat.total} 个（code ${stat.code} / md ${stat.md}），共 ${stat.lines} 行
 */`;

const body = `${banner}
export const KAGGLE_SOURCE = {
  name: ${JSON.stringify(relName)},
  importedAt: ${JSON.stringify(new Date().toISOString())},
  meta: ${JSON.stringify({ kernel: meta.kernel || 'python3', language: meta.language || 'python', codeCells: stat.code, totalCells: stat.total, accelerator: meta.accelerator || null }, null, 2)},
};

/** 真实 Kaggle notebook 的单元格（模拟器默认加载） */
export const KAGGLE_CELLS = ${JSON.stringify(cells, null, 2)};
`;

fs.writeFileSync(OUT, body);
console.log(`✓ 已生成 src/kaggle-code.js`);
console.log(`  · 单元格 ${stat.total} 个：code ${stat.code} / md ${stat.md}`);
console.log(`  · 代码 ${stat.lines} 行 · kernel ${meta.kernel || 'python3'}`);
console.log(`\n下一步：刷新模拟器页面，Notebook 里就是你的真实代码了。`);
console.log(`想恢复示例 notebook：点侧栏「↺ 载入示例 notebook」。`);
