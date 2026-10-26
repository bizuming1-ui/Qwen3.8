/**
 * minipy.js — 极简 Python 语义模拟
 * 目标：让粘贴进来的真实 Kaggle 代码也能产出「看起来对」的输出，
 * 而不是只有一句"未定义操作"。
 *
 * 做的事：
 *  - 维护变量表，识别 `name = expr` 赋值
 *  - 求值 print(...) 的每个参数（含 f-string、len()、简单表达式）
 *  - 内置 torch / numpy / os / librosa / soundfile 的桩实现
 *  - 跳过 def / class / for / while / if 的函数体（不真正执行）
 * 安全：只对「赋值右侧」和「print 实参」这类表达式求值，不执行语句块。
 */
import { ACCELERATORS } from './data.js';

const DEVICE_NAME = {
  t4x2: 'Tesla T4', p100: 'Tesla P100-PCIE-16GB', tpu: 'TPU v3-8', cpu: null,
};

/** 拆出顶层括号内的内容（支持嵌套/字符串） */
function takeParens(src, start) {
  // start 指向 '('
  let depth = 0, i = start, quote = null;
  for (; i < src.length; i++) {
    const c = src[i];
    if (quote) {
      if (c === '\\') { i++; continue; }
      if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'") { quote = c; continue; }
    if (c === '(') depth++;
    else if (c === ')') { depth--; if (depth === 0) return { inner: src.slice(start + 1, i), end: i }; }
  }
  return { inner: src.slice(start + 1), end: src.length };
}

/** 按顶层逗号切分实参 */
function splitArgs(s) {
  const out = [];
  let depth = 0, quote = null, cur = '';
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (quote) {
      cur += c;
      if (c === '\\') { cur += s[++i] || ''; continue; }
      if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'") { quote = c; cur += c; continue; }
    if ('([{'.includes(c)) depth++;
    if (')]}'.includes(c)) depth--;
    if (c === ',' && depth === 0) { out.push(cur.trim()); cur = ''; continue; }
    cur += c;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

/** 去掉行内注释（不在字符串里的 #） */
function stripComment(line) {
  let quote = null;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quote) {
      if (c === '\\') { i++; continue; }
      if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'") { quote = c; continue; }
    if (c === '#') return line.slice(0, i);
  }
  return line;
}

function fmtPy(v) {
  if (v === null || v === undefined) return 'None';
  if (v === true) return 'True';
  if (v === false) return 'False';
  if (typeof v === 'number') return Number.isInteger(v) ? String(v) : String(Math.round(v * 1e6) / 1e6);
  if (typeof v === 'string') return v;
  if (Array.isArray(v)) return `[${v.map(fmtPy).join(', ')}]`;
  if (typeof v === 'object' && v.__pyrepr) return v.__pyrepr;
  if (typeof v === 'object' && typeof v.shape !== 'undefined') return `tensor(${JSON.stringify(v.data || [])}, shape=${JSON.stringify(v.shape)})`;
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}

/** 构造沙箱上下文 */
export function makeSandbox(app) {
  const accelKey = app?.state?.accelerator || 't4x2';
  const accel = ACCELERATORS[accelKey] || ACCELERATORS.t4x2;
  const hasGpu = accel.flavor === 'gpu';
  const files = (app?.state?.files || []).map((f) => f.name);

  const tensor = (shape = [1, 16000], data = null) => ({
    shape, data: data || new Array(shape.reduce((a, b) => a * b, 1)).fill(0),
    __pyrepr: `tensor([[...]], shape=${JSON.stringify(shape)})`,
    to: () => tensor(shape), cpu: () => tensor(shape), numpy: () => ({ shape, data }),
  });

  const torch = {
    __version__: hasGpu ? '2.3.1+cu121' : '2.3.1',
    cuda: {
      is_available: () => hasGpu,
      device_count: () => accel.gpus.length,
      get_device_name: () => DEVICE_NAME[accelKey] || 'cpu',
      get_device_properties: () => ({ total_memory: (accel.vramTotal || 0) * 1024 ** 3, name: DEVICE_NAME[accelKey] }),
      empty_cache: () => null,
      manual_seed_all: () => null,
    },
    backends: { cudnn: { version: () => (hasGpu ? 8907 : null) } },
    device: (x) => (x || (hasGpu ? 'cuda:0' : 'cpu')),
    tensor, zeros: (s) => tensor(Array.isArray(s) ? s : [s]), ones: (s) => tensor(Array.isArray(s) ? s : [s]),
    randn: (s) => tensor(Array.isArray(s) ? s : [s]), from_numpy: () => tensor(),
    float16: 'float16', float32: 'float32', long: 'int64',
    save: (obj, path) => { app?.addFile?.(String(path).split('/').pop(), 50790); return null; },
    load: () => ({ weights: true }),
    no_grad: () => ({ __enter: () => null, __exit: () => null }),
  };

  const np = {
    __version__: '1.26.4',
    float32: 'float32', int64: 'int64',
    array: (d) => ({ shape: [Array.isArray(d) ? d.length : 1], data: d, __pyrepr: `array(${JSON.stringify(d)})` }),
    zeros: (n) => ({ shape: [n], __pyrepr: `array([${new Array(Math.min(n, 4)).fill('0.').join(', ')}${n > 4 ? ', ...' : ''}])` }),
    random: { seed: () => null, rand: () => 0.42, randn: () => 0.07 },
    mean: (a) => (Array.isArray(a) ? a.reduce((x, y) => x + y, 0) / (a.length || 1) : 0),
    max: (a) => (Array.isArray(a) ? Math.max(...a) : a),
    pi: Math.PI,
  };

  const os = {
    getcwd: () => '/kaggle/working',
    listdir: (p) => (String(p || '').includes('input') ? ['metadata.csv', 'wavs', 'ref'] : files.slice()),
    makedirs: () => null,
    mkdir: () => null,
    path: {
      join: (...a) => a.join('/').replace(/\/+/g, '/'),
      exists: (p) => !String(p).includes('nope'),
      basename: (p) => String(p).split('/').pop(),
      dirname: (p) => String(p).split('/').slice(0, -1).join('/') || '.',
      splitext: (p) => { const m = String(p).match(/^(.*)(\.[^.]+)$/); return m ? [m[1], m[2]] : [p, '']; },
    },
    environ: { get: (k) => (k === 'CUDA_VISIBLE_DEVICES' ? (hasGpu ? '0,1' : '') : '') },
    walk: () => [],
    cpu_count: () => 4,
  };

  const sys = { version: '3.11.9 (main, Apr  2 2024)', platform: 'linux', argv: ['train.py'] };
  const librosa = {
    load: () => [{ shape: [1, 48000] }, 24000],
    get_duration: () => 2.0,
    feature: { mfcc: () => ({ shape: [20, 94], __pyrepr: 'array([[...,...]], shape=(20, 94))' }) },
  };
  const soundfile = { write: (p) => { app?.addFile?.(String(p).split('/').pop(), 5120); return null; }, read: () => [{ shape: [24000] }, 24000] };
  const IPython = { display: { Audio: () => ({ __pyrepr: '<IPython.lib.display.Audio object>' }) } };

  const builtins = {
    print: () => null, len: (x) => (x == null ? 0 : (x.length ?? x.shape?.[0] ?? Object.keys(x).length)),
    str: fmtPy, int: (x) => parseInt(x, 10) || 0, float: (x) => parseFloat(x) || 0,
    bool: (x) => !!x, round: (x, n = 0) => Math.round(x * 10 ** n) / 10 ** n,
    abs: Math.abs, min: (...a) => Math.min(...(Array.isArray(a[0]) ? a[0] : a)),
    max: (...a) => Math.max(...(Array.isArray(a[0]) ? a[0] : a)),
    sum: (a) => (Array.isArray(a) ? a.reduce((x, y) => x + y, 0) : 0),
    sorted: (a) => (Array.isArray(a) ? [...a].sort() : a), list: (a) => (Array.isArray(a) ? a : []),
    type: (x) => (x === null ? "<class 'NoneType'>" : `<class '${Array.isArray(x) ? 'list' : typeof x}'>`),
    isinstance: (x, t) => typeof x === String(t).replace(/'/g, ''),
    range: (n) => Array.from({ length: n }, (_, i) => i),
    enumerate: (a) => (Array.isArray(a) ? a.map((v, i) => [i, v]) : []),
    zip: (...a) => a[0].map((v, i) => a.map((x) => x[i])),
    format: (x) => String(x), open: () => ({ read: () => '', close: () => null }),
    torch, np, numpy: np, os, sys, librosa, sf: soundfile, soundfile, IPython,
    tqdm: (a) => a, glob: () => files.map((f) => '/kaggle/working/' + f),
    warnings: { filterwarnings: () => null },
    random: { seed: () => null, random: () => 0.5, choice: (a) => a[0] },
    time: { time: () => Date.now() / 1000, sleep: () => null },
    json: { load: () => ({}), dump: () => null, dumps: () => '{}', loads: () => ({}) },
    Path: (p) => ({ __pyrepr: `PosixPath('${p}')`, exists: () => true, __str__: () => p }),
  };

  return { ...builtins };
}

/**
 * Python 表达式 → JS 表达式
 * 处理三元表达式、and/or/not、True/False/None、is None、整数除法等常见写法
 */
export function pyToJs(expr) {
  let out = String(expr).trim();

  // a if cond else b  （可能嵌套，循环几次；只处理不含逗号的简单形态）
  for (let i = 0; i < 3; i++) {
    const next = out.replace(/^(.+?)\s+if\s+(.+?)\s+else\s+(.+)$/, '($2 ? $1 : $3)');
    if (next === out) break;
    out = next;
  }

  out = out
    .replace(/\bis\s+not\s+None\b/g, '!= null')
    .replace(/\bis\s+None\b/g, '== null')
    .replace(/\bnot\s+/g, '!')
    .replace(/\band\b/g, '&&')
    .replace(/\bor\b/g, '||')
    .replace(/\bTrue\b/g, 'true')
    .replace(/\bFalse\b/g, 'false')
    .replace(/\bNone\b/g, 'null')
    .replace(/\/\//g, '/');   // 整数除法按普通除法近似

  return out;
}

/** 在沙箱中安全地求值一个表达式 */
function evalExpr(expr, ctx) {
  const src = String(expr).trim();
  if (!src) throw new Error('empty');
  // f-string → 先求内部表达式
  const fstr = src.match(/^f(["'])([\s\S]*)\1$/);
  if (fstr) {
    const body = fstr[2].replace(/\{([^{}]+)\}/g, (_, e) => {
      try { return fmtPy(evalExpr(e, ctx)); } catch { return `{${e}}`; }
    });
    return body;
  }
  // 关键字参数（print(..., file=..., end=...)）
  const js = pyToJs(src);
  const fn = new Function('ctx', `with (ctx) { return (${js}); }`);
  return fn(ctx);
}

/**
 * 执行一个「真实代码」单元格，返回输出事件数组
 * @returns {{lines: {text: string, cls?: string}[], note?: string}}
 */
export async function runGenericCell(code, app) {
  const ctx = makeSandbox(app);
  const lines = [];
  // 预处理：去 %%magic / %magic 行，剥掉三引号块
  let src = String(code)
    .replace(/^\s*%%?[a-zA-Z_]+.*$/gm, (m) => (m.trim().startsWith('%%time') || m.trim().startsWith('%%capture') ? '' : m))
    .replace(/("""|''')[\s\S]*?\1/g, (m) => (m.includes('{') ? m : "''"));

  const rawLines = src.split('\n');
  let skipBlockIndent = null;   // 正在跳过某个语句体
  let commentBlock = [];

  for (let raw of rawLines) {
    const line = stripComment(raw).replace(/\s+$/, '');
    const trimmed = line.trim();
    if (!trimmed) continue;

    const indent = line.length - line.trimStart().length;

    // 语句块跳过：def/class/for/while/if/try/with 的缩进体
    if (skipBlockIndent !== null) {
      if (indent > skipBlockIndent) continue;
      skipBlockIndent = null;
    }

    // shell
    if (/^!/.test(trimmed)) {
      lines.push({ text: `$ ${trimmed.replace(/^!\s*/, '')}`, cls: 'dim' });
      continue;
    }
    if (/^%/.test(trimmed)) {
      if (/^%cd/.test(trimmed)) lines.push({ text: `/kaggle/working`, cls: 'dim' });
      continue;
    }

    // 块开头（含 def/class/for/if 等）
    if (/^(def|class|for|while|if|elif|else|try|except|finally|with|async)\b/.test(trimmed)) {
      if (trimmed.endsWith(':')) skipBlockIndent = indent;
      continue;
    }

    // import
    if (/^(import|from)\s+/.test(trimmed)) continue;

    // print(...) —— 支持同一行多个 / 嵌套
    const printRe = /(?:^|[^.\w])print\s*\(/g;
    let m;
    let handledPrint = false;
    while ((m = printRe.exec(trimmed))) {
      const openIdx = trimmed.indexOf('(', m.index + m[0].length - 1);
      const { inner } = takeParens(trimmed, openIdx);
      handledPrint = true;
      const args = splitArgs(inner).filter((a) => !/^\w+\s*=/.test(a) || /^sep\s*=/.test(a));
      const vals = args.map((a) => {
        try { return fmtPy(evalExpr(a, ctx)); } catch { return a.replace(/^["']|["']$/g, ''); }
      });
      lines.push({ text: vals.join(' ') });
    }
    if (handledPrint) continue;

    // 赋值
    const assign = trimmed.match(/^([A-Za-z_][\w.,\s\[\]]*?)\s*=\s*([^=].*)$/);
    if (assign) {
      const target = assign[1].trim();
      const expr = assign[2].trim();
      if (/^[A-Za-z_]\w*$/.test(target)) {
        try { ctx[target] = evalExpr(expr, ctx); } catch { /* 留空 */ }
      }
      continue;
    }

    // 单独的表达式语句（如 model.eval()）
    if (/^[A-Za-z_][\w.]*\s*\(/.test(trimmed)) {
      // 已知能产出输出的：display / Audio / write
      const disp = trimmed.match(/^display\s*\(/);
      if (disp) { lines.push({ text: '<IPython.core.display.HTML object>', cls: 'dim' }); }
      continue;
    }
  }

  return { lines };
}
