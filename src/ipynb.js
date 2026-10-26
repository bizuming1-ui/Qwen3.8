/**
 * ipynb.js — 解析真实的 Kaggle 代码
 * 支持：
 *   .ipynb  → 读取 JSON 单元格（code / markdown / raw）
 *   .py     → 按 `# %%` / `# In[ ]` 分节（jupytext / VS Code 风格）
 *   .txt/.md→ 整段作为一个单元格（自动识别是否含代码）
 */

/** 把 ipynb 的 source 数组/字符串统一成字符串 */
function joinSource(src) {
  if (Array.isArray(src)) return src.join('');
  if (typeof src === 'string') return src;
  return '';
}

/** 提取一段 IPython 源码里的文本输出（用于 markdown 汇总） */
function stripAnsi(s) {
  return String(s).replace(/\u001b\[[0-9;]*m/g, '');
}

/**
 * @param {string} text 文件内容
 * @param {string} filename 文件名（决定解析方式）
 * @returns {{cells: {type: string, source: string}[], meta: object}}
 */
export function parseNotebookText(text, filename = '') {
  const lower = filename.toLowerCase();
  const isJson = lower.endsWith('.ipynb') || /^\s*\{[\s\S]*"cells"/.test(text);

  if (isJson) {
    let nb;
    try {
      nb = JSON.parse(text);
    } catch (e) {
      throw new Error('不是合法的 .ipynb JSON：' + e.message);
    }
    const raw = nb.cells || (nb.worksheets && nb.worksheets[0]?.cells) || [];
    const cells = raw
      .map((c) => ({
        type: c.cell_type === 'markdown' ? 'md' : c.cell_type === 'raw' ? 'md' : 'code',
        source: joinSource(c.source).replace(/\s+$/, ''),
      }))
      .filter((c) => c.source.trim().length > 0);

    const meta = {
      name: (nb.metadata && nb.metadata.kernelspec && nb.metadata.kernelspec.display_name) || filename,
      kernel: nb.metadata?.kernelspec?.name || 'python3',
      language: nb.metadata?.language_info || nb.metadata?.language || 'python',
      accelerator: nb.metadata?.accelerator || nb.metadata?.kaggle?.accelerator || null,
      totalCells: raw.length,
      codeCells: cells.filter((c) => c.type === 'code').length,
    };
    return { cells, meta };
  }

  if (lower.endsWith('.py') || lower.endsWith('.py.txt')) {
    // 按 # %% 或 # In[ ] 切分
    const parts = text.split(/^#[ \t]*(?:%%|In\[[^\]]*\])[^\n]*$/gm);
    const cells = parts
      .map((p) => p.replace(/^\s+|\s+$/g, '\n').trim())
      .filter(Boolean)
      .map((p) => ({ type: /^\s*(#|"""|''')/.test(p) && !/[=()]/.test(p.split('\n')[0]) ? 'md' : 'code', source: p }));
    if (cells.length <= 1) {
      return { cells: [{ type: 'code', source: text.trim() }], meta: { name: filename, kernel: 'python3', totalCells: 1, codeCells: 1 } };
    }
    return { cells, meta: { name: filename, kernel: 'python3', totalCells: cells.length, codeCells: cells.filter((c) => c.type === 'code').length } };
  }

  // 纯文本 / markdown：整段一个单元格
  const looksCode = /(?:^|\n)\s*(?:import |from |def |class |for |!|%|print\()/.test(text);
  return {
    cells: [{ type: looksCode ? 'code' : 'md', source: text.trim() }],
    meta: { name: filename, kernel: 'python3', totalCells: 1, codeCells: looksCode ? 1 : 0 },
  };
}

/** 生成 .ipynb JSON（把模拟器里的单元格导出成真的 notebook 文件） */
export function cellsToIpynb(cells, meta = {}) {
  const nb = {
    cells: cells.map((c) => {
      const src = String(c.source || '').split('\n').map((l, i, a) => (i < a.length - 1 ? l + '\n' : l));
      if (c.type === 'md') {
        return { cell_type: 'markdown', metadata: {}, source: src };
      }
      return {
        cell_type: 'code',
        execution_count: c.count || null,
        metadata: {},
        outputs: [],
        source: src,
      };
    }),
    metadata: {
      kernelspec: { display_name: 'Python 3', language: 'python', name: 'python3' },
      language_info: { name: 'python', version: '3.11.9' },
      ...(meta.name ? { kaggle: { source: meta.name } } : {}),
    },
    nbformat: 4,
    nbformat_minor: 5,
  };
  return JSON.stringify(nb, null, 1);
}

/** 汇总统计，给 UI 展示 */
export function summarize(cells) {
  const code = cells.filter((c) => c.type === 'code').length;
  const lines = cells.reduce((a, c) => a + c.source.split('\n').length, 0);
  return { total: cells.length, code, md: cells.length - code, lines };
}

export { stripAnsi };
