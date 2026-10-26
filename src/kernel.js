/**
 * kernel.js — 模拟 Kaggle Kernel
 * 解释 notebook 单元格：nvidia-smi / pip / 数据挂载 / 画图 / 训练 / 推理
 * 以 async generator 形式逐事件产出输出（可中断）
 */
import { ACCELERATORS, SPEAKERS } from './data.js';
import { synthesizeSpeech, analyzeAudio, SR } from './audio.js';
import { sleep, fmt, rng, gauss } from './util.js';

const out = (text, cls = '', cr = false) => ({ type: 'stream', text, cls, cr });

export class FakeKernel {
  constructor(app) {
    this.app = app;
    this.pkg = {};           // 已安装的包
    this.state = 'idle';
  }

  get accel() {
    const key = this.app.state.accelerator || 't4x2';
    return { key, ...ACCELERATORS[key] };
  }

  /** 生成当前使用的参考音频（样本 or 合成） */
  getReference() {
    const st = this.app.state;
    if (st.refSamples && st.refSamples.length) {
      return { samples: st.refSamples, sr: st.refSr || SR, name: st.refName || 'ref.wav', analysis: st.refAnalysis };
    }
    if (!this._refCache) {
      const spk = SPEAKERS[1];
      const r = synthesizeSpeech({
        text: 'The quick brown fox jumps over the lazy dog.',
        speaker: spk, speed: 1, expr: 0.4,
      });
      this._refCache = { samples: r.samples, sr: r.sr, name: 'ref/spk01.wav', analysis: analyzeAudio(r.samples, r.sr) };
    }
    return this._refCache;
  }

  /** ═══════ 主入口 ═══════ */
  async *run(source, ctx) {
    const src = String(source);
    const code = src.trim();
    if (!code) { yield out('# 空单元格', 'dim'); return; }

    const lines = code.split('\n');
    const head = lines[0];

    // ── !nvidia-smi ──
    if (/^!\s*nvidia-smi/.test(head)) { yield* this.nvidiaSmi(); return; }

    // ── !pip install ──
    if (/^!\s*pip\s+install/.test(head) || /^%\s*pip\s+install/.test(head)) {
      yield* this.pipInstall(code); return;
    }

    // ── !ls / !pwd / !df / !cat / !du ──
    if (/^!\s*(ls|pwd|df|du|cat|free|cat )/.test(head)) { yield* this.shell(code); return; }

    // ── torch 环境 ──
    if (/import torch/.test(code) && /torch\.cuda|torch\.backends/.test(code)) { yield* this.torchInfo(); return; }

    // ── os.walk 数据集 ──
    if (/os\.walk\(/.test(code)) { yield* this.mountData(code); return; }

    // ── plot_waveform ──
    if (/plot_waveform|torchaudio\.load/.test(code)) { yield* this.loadAudio(code); return; }

    // ── display(Audio(...)) ──
    if (/display\(\s*Audio\(/.test(code)) { yield* this.playAudio(); return; }

    // ── 训练循环 ──
    if (/for\s+epoch\s+in\s+range/.test(code) && /loss\.backward|save_checkpoint/.test(code)) { yield* this.train(); return; }

    // ── 推理 ──
    if (/\.synthesize\(/.test(code)) { yield* this.infer(code); return; }

    // ── 只加载音频 / 通用 print ──
    if (/^\s*print\(/.test(code) || /print\(/.test(code)) { yield* this.genericPrint(code); return; }

    yield out('# 单元格执行完成（模拟器未定义该操作）', 'dim');
  }

  /* ══════════════════════ 各单元实现 ══════════════════════ */

  async *nvidiaSmi() {
    const a = this.accel;
    yield out('Mon Oct 26 14:02:11 2026       ', 'dim');
    yield out('+-----------------------------------------------------------------------------------------+', 'dim');
    yield out('| NVIDIA-SMI 550.54.15              Driver Version: 550.54.15      CUDA Version: 12.4    |', 'dim');
    yield out('|-----------------------------------------+------------------------+----------------------+', 'dim');
    yield out('| GPU  Name                 Persistence-M | Bus-Id          Disp.A | Volatile Uncorr. ECC |', 'dim');
    yield out('| Fan  Temp   Perf          Pwr:Usage/Cap |           Memory-Usage | GPU-Util  Compute M. |', 'dim');

    if (!a.gpus.length) {
      yield out('');
      yield out('No devices were found', 'err');
      yield { type: 'error', text: 'CommandError: exit status 6 — 当前 Accelerator 未分配 GPU。请到右侧设置切换为 GPU T4 ×2。' };
      return;
    }
    for (const [name, mem] of a.gpus) {
      const used = 0;
      yield out(`|   0  ${name.padEnd(24)}Off | 00000000:00:04.0 Off |                    0 |`, '');
      yield out(`| N/A   41C    P8             10W /  70W |      ${String(used).padStart(4)}MiB / ${String(mem).padStart(6)}MiB |      0%      Default |`, '');
    }
    yield out('+-----------------------------------------+------------------------+----------------------+', 'dim');
    yield out('');
    yield out('+-----------------------------------------------------------------------------------------+', 'dim');
    yield out('| Processes:                                                                              |', 'dim');
    yield out('|  GPU   GI   CI        PID   Type   Process name                              GPU Memory |', 'dim');
    yield out('|  No running processes found                                                             |', 'dim');
    yield out('+-----------------------------------------------------------------------------------------+', 'dim');
    yield { type: 'metrics', items: [
      { k: 'GPU 数量', v: String(a.gpus.length) },
      { k: '显存合计', v: `${(a.vramTotal).toFixed(0)} GB` },
      { k: 'CUDA', v: '12.4' },
      { k: 'Driver', v: '550.54' },
    ] };
    this.app.log(`nvidia-smi → ${a.gpus.length} GPU(s) 已就绪`, 'ok');
  }

  async *pipInstall(code) {
    const pkgs = code.replace(/^[!%]\s*pip\s+install\s*(-q\s*)?/, '').trim().split(/\s+/).filter(Boolean);
    if (!this.app.state.internet) {
      yield out(`WARNING: Retrying (Retry(total=4, connect=None, read=None, redirect=None, status=None)) after connection broken by 'NewConnectionError('<pip._vendor.urllib3.connection.HTTPSConnection object at 0x7f2a1c3d5e50>: Failed to establish a new connection: [Errno -3] Temporary failure in name resolution')': /simple/${pkgs[0] || 'tts'}/`, 'warn');
      yield out('');
      yield { type: 'error', text: 'ERROR: Could not find a version that satisfies the requirement (网络不可达)\n提示：Kaggle Notebook 的 Internet 开关是关闭的，打开右上角 Internet 再试。' };
      return;
    }
    yield out(`Looking in indexes: https://pypi.org/simple, https://www.kaggle.com/api/v1/third-party`, 'dim');
    await sleep(280);
    for (const p of pkgs) {
      const ver = p.includes('==') ? p.split('==')[1] : { TTS: '0.22.0', librosa: '0.10.2', soundfile: '0.12.1' }[p] || '2.0.1';
      const pkgName = p.split('==')[0];
      const wheels = [
        `Downloading ${pkgName}-${ver}-cp311-cp311-manylinux_2_17_x86_64.whl (1.2 MB)`,
        `Downloading ${pkgName}-${ver}.tar.gz (412 kB)`,
      ];
      yield out(wheels[p.length % 2], 'dim');
      await sleep(320);
      yield out(`   ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ ${(Math.random() * 20 + 20).toFixed(1)}/42.1 MB ${(Math.random() * 40 + 40).toFixed(1)} MB/s eta 0:00:0${Math.floor(Math.random() * 9)}`, 'dim');
      await sleep(260);
      this.pkg[pkgName] = ver;
      this.app.addDisk(0.09);
    }
    yield out(`Successfully installed ${pkgs.map((p) => p.split('==')[0].replace(/([A-Z])/g, '-$1').toLowerCase().replace(/^-/, '') + '-' + (p.split('==')[1] || '0.22.0')).join(' ')}`, 'ok');
    yield { type: 'stream', text: `# 6 packages 已安装 · 用时 ${fmt(2.4 + pkgs.length * 0.6, 1)}s`, cls: 'dim' };
    this.app.log(`pip install ${pkgs.join(' ')} 完成`, 'ok');
  }

  async *shell(code) {
    const cmd = code.replace(/^!\s*/, '').trim();
    const parts = cmd.split(/\s+/);
    const base = parts[0];
    if (base === 'pwd') { yield out('/kaggle/working'); return; }
    if (base === 'df') {
      yield out('Filesystem      Size  Used Avail Use% Mounted on', 'dim');
      yield out('/dev/sda1        20G  4.2G   16G  21% /kaggle/working');
      yield out('tmpfs            29G     0   29G   0% /dev/shm', 'dim');
      return;
    }
    if (base === 'free') {
      yield out('               total        used        free      shared  buff/cache   available', 'dim');
      yield out('Mem:            29Gi       3.1Gi       7.4Gi       1.0Gi        18Gi        25Gi');
      return;
    }
    if (base === 'cat') {
      const f = parts[parts.length - 1];
      if (f.includes('metadata')) {
        yield out('LJ001-0001|Printing, in the only sense with which we are at present concerned...|Printing, in the only sense with which we are at present concerned...', 'dim');
        yield out('LJ001-0002|An objection is not a misrepresentation,...|An objection is not a misrepresentation,...', 'dim');
      } else yield out(`cat: ${f}: No such file or directory`, 'err');
      return;
    }
    if (base === 'du') {
      yield out('2.4G\t/kaggle/input/ljspeech-1-1');
      return;
    }
    if (base === 'ls') {
      const long = parts.some((p) => /^-.*l/.test(p));
      const target = parts.slice(1).find((p) => !p.startsWith('-')) || '.';
      const files = this.app.state.files;
      if (!files.length) { yield out('# /kaggle/working 为空', 'dim'); return; }
      if (long) {
        yield out('total 486M', 'dim');
        for (const f of files) {
          yield out(`${f.dir ? 'drwxr-xr-x' : '-rw-r--r--'} 1 root root ${this.sizeStr(f.size).padStart(6)} Oct 26 14:0${Math.floor(Math.random() * 9)} ${f.name}`);
        }
      } else yield out(files.map((f) => f.name).join('  '));
      return;
    }
    yield { type: 'error', text: `ShellException: ${base}: command not found` };
  }

  sizeStr(kb) {
    if (kb > 1024 * 1024) return `${(kb / 1024 / 1024).toFixed(1)}G`;
    if (kb > 1024) return `${(kb / 1024).toFixed(0)}M`;
    return `${Math.round(kb)}K`;
  }

  async *torchInfo() {
    const a = this.accel;
    yield out(`torch ${a.flavor === 'gpu' ? '2.3.1+cu121' : '2.3.1'}`);
    if (a.flavor === 'gpu') {
      yield out(`cuda ${a.gpus[0][0]}`);
      yield out('cudnn 8907');
      yield { type: 'metrics', items: [
        { k: 'torch', v: '2.3.1+cu121' }, { k: 'device', v: 'cuda:0' },
        { k: 'cudnn', v: '8907' }, { k: 'fp16', v: '支持' },
      ] };
    } else if (a.flavor === 'tpu') {
      yield { type: 'error', text: "RuntimeError: Found no NVIDIA driver on your system. TPU VM 上没有 CUDA —— 请改用 torch_xla 或切换 Accelerator 为 GPU T4 ×2。" };
    } else {
      yield { type: 'error', text: 'RuntimeError: Found no NVIDIA driver on your system. Please check that you have an NVIDIA GPU and installed a driver. (当前为 CPU only)' };
    }
  }

  async *mountData(code) {
    const ds = this.app.state.activeDataset || 'ljspeech';
    const { DATASETS } = await import('./data.js');
    const meta = DATASETS.find((d) => d.id === ds) || DATASETS[0];
    const root = `/kaggle/input/${meta.name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`;
    const rows = [
      [root, meta.files.length * 1230],
      [`${root}/wavs`, 13100],
      [`${root}/ref`, 1],
    ];
    if (ds === 'vctk') { rows.length = 0; rows.push([root, 44313], [`${root}/wav48_silence_trimmed`, 44313], [`${root}/txt`, 1090]); }
    for (const [p, n] of rows) {
      yield out(`${p} ${n}`, '');
      await sleep(90);
    }
    yield { type: 'table', headers: ['path', 'files', 'split'], rows: rows.map(([p, n], i) => [p, n, i === 1 ? 'train' : '—']) };
  }

  async *loadAudio(code) {
    const ref = this.getReference();
    const an = ref.analysis;
    const frames = Math.round(ref.samples.length / ref.sr * 100);
    yield out(`torch.Size([1, ${ref.samples.length}]) ${ref.sr}`);
    yield out(`# 时长 ${fmt(an.duration, 2)}s · 峰值 ${fmt(an.peak, 3)} · RMS ${fmt(an.rms, 3)} · F0≈${Math.round(an.f0)}Hz`, 'dim');
    const data = { samples: ref.samples, sr: ref.sr };
    yield {
      type: 'fig', id: 'wave' + Math.random().toString(36).slice(2, 7), height: 150,
      caption: 'matplotlib · waveform (torchaudio + matplotlib 模拟)',
      draw: (canvas) => import('./charts.js').then((m) => m.waveChart(canvas, data.samples, data.sr, { title: 'waveform', color: '#1f9bd6' })),
    };
    yield { type: 'metrics', items: [
      { k: 'duration', v: `${fmt(an.duration, 2)}s` },
      { k: 'sr', v: String(ref.sr) },
      { k: 'F0', v: `${Math.round(an.f0)} Hz` },
      { k: 'centroid', v: `${Math.round(an.centroid)} Hz` },
    ] };
  }

  async *playAudio() {
    const ref = this.getReference();
    yield { type: 'audio', samples: ref.samples, sr: ref.sr, label: `Audio · ${ref.name} · ${fmt(ref.analysis.duration, 2)}s` };
    yield out(`<IPython.lib.display.Audio object>  (rate=${ref.sr}, duration=${fmt(ref.analysis.duration, 2)}s)`, 'dim');
  }

  async *infer(code) {
    const a = this.accel;
    if (a.flavor === 'cpu') {
      yield out('Loading checkpoint ckpt_e20.pt …', 'dim');
      yield { type: 'error', text: 'AssertionError: Torch not compiled with CUDA enabled —— 推理需要 GPU。' };
      return;
    }
    const textMatch = code.match(/text\s*=\s*"([^"]*)"/);
    const text = textMatch ? textMatch[1] : this.app.state.studioText;
    const spkId = (code.match(/speaker_wav\s*=\s*f?"?\{?DATA\}?\/ref\/([a-zA-Z0-9_]+)/) || [])[1];
    const spk = SPEAKERS.find((s) => s.name.toLowerCase().includes((spkId || '').slice(0, 3))) || this.app.getSpeaker();

    yield out('Loading model VITS (checkpoint ckpt_e20.pt) …', 'dim');
    await sleep(420);
    yield out('  ✓ 12.4M 参数 · fp16 · device=cuda:0', 'ok');
    yield out(`G2P: ${text.slice(0, 42)}${text.length > 42 ? '…' : ''}`, 'dim');
    await sleep(260);
    const t0 = performance.now();
    const r = synthesizeSpeech({
      text, speaker: spk, speed: this.app.state.speed,
      expr: this.app.state.expr, pitchShift: this.app.state.pitchShift,
    });
    const ms = performance.now() - t0;
    const an = analyzeAudio(r.samples, r.sr);
    yield out(`generating mel: ${Math.round(r.samples.length / SR * 100)} frames`, 'dim');
    yield out(`HiFi-GAN vocoder: ${fmt(an.duration, 2)}s audio @ ${r.sr}Hz`, 'dim');
    yield out(`✓ RTF ${fmt(ms / 1000 / Math.max(0.01, an.duration), 3)} · 用时 ${fmt(ms / 1000, 2)}s`, 'ok');
    yield { type: 'audio', samples: r.samples, sr: r.sr, label: `Audio · ${spk.name} · ${fmt(an.duration, 2)}s` };
    yield { type: 'metrics', items: [
      { k: 'speaker', v: spk.name }, { k: 'F0', v: `${Math.round(an.f0)} Hz` },
      { k: 'centroid', v: `${Math.round(an.centroid)} Hz` }, { k: 'RTF', v: fmt(ms / 1000 / an.duration, 3) },
    ] };
    // 同步到 Studio 输出
    this.app.setStudioOutput(r.samples, r.sr, an, spk);
    this.app.log(`推理完成 · ${spk.name} · ${fmt(an.duration, 2)}s`, 'ok');
  }

  async *train() {
    const a = this.accel;
    if (a.flavor === 'cpu' && this.app.state.accelerator === 'cpu') {
      yield { type: 'error', text: 'RuntimeError: CUDA error: no CUDA-capable device is detected —— 训练必须切到 GPU Accelerator。' };
      return;
    }
    const epochs = 20;
    const r = rng(20261026);
    yield out(`[VITS] num_chars=256 spec_channels=513 segment_size=8192`, 'dim');
    yield out(`[VITS] 参数量 12.4M · fp16 · batch=16 · lr=2e-4`, 'dim');
    yield out(`Trainer: 820 batches/epoch, ${epochs} epochs`, 'dim');
    yield out('');

    const hist = { mel: [], kl: [], disc: [] };
    const figId = 'loss' + Math.random().toString(36).slice(2, 7);
    yield {
      type: 'fig', id: figId, height: 190, caption: 'training curves · mel_loss / kl_loss',
      draw: (canvas) => import('./charts.js').then((m) => m.lineChart(canvas, {
        series: [
          { data: hist.mel, color: '#20beff', label: 'mel_loss', fill: true },
          { data: hist.kl.map((v) => v * 12), color: '#ff7ac3', label: 'kl×12' },
        ],
        xLabel: 'epoch', yLabel: 'loss', height: 190,
      })),
    };

    let mel = 8.4, kl = 4.6;
    for (let e = 1; e <= epochs; e++) {
      if (e === 1) {
        for (let s = 0; s < 8; s++) {
          const pct = Math.round(((s + 1) / 8) * 100);
          const bar = '━'.repeat(Math.round(pct / 4)).padEnd(25, ' ');
          yield out(`  ${pct}%|${bar}| ${Math.round((pct / 100) * 820)}/820 [00:${String(s * 3 + 2).padStart(2, '0')}<00:00, ${(28 + r() * 20).toFixed(1)}it/s]`, 'dim', s > 0);
          await sleep(45);
        }
        yield out('');
      }
      mel = Math.max(0.38, mel * (0.86 + gauss(r) * 0.012) - 0.02);
      kl = Math.max(0.11, kl * (0.88 + gauss(r) * 0.02));
      hist.mel.push(mel);
      hist.kl.push(kl);
      hist.disc.push(0.9 - mel * 0.05);
      yield { type: 'figTick', id: figId };
      const loud = e % 5 === 0 || e === 1;
      const genLoss = (2.1 + gauss(r) * 0.05) * Math.max(0.12, 1 - e / 26);
      yield out(
        `epoch ${String(e).padStart(2)}/${epochs}  mel_loss ${mel.toFixed(4)}  kl ${kl.toFixed(4)}  gen ${genLoss.toFixed(3)}  lr 2.00e-4  ${((e / epochs) * 100).toFixed(0)}%`,
        e % 5 === 0 ? 'hl' : '', false,
      );
      if (loud) {
        yield out(`  ↳ checkpoint → /kaggle/working/ckpt_e${e}.pt  (49.6 MB)`, 'dim');
        this.app.addFile(`ckpt_e${e}.pt`, 50790);
        this.app.setRunProgress(e / epochs);
      }
      await sleep(80);
    }
    yield out('');
    yield out(`✓ 训练完成 · ${epochs} epochs · 总耗时 6m 42s`, 'ok');
    this.app.setRunProgress(1);
    this.app.addFile('ckpt_e20.pt', 50790);
    yield { type: 'table', headers: ['epoch', 'mel_loss', 'kl_loss', 'ckpt'], rows: [
      ['1', '8.2831', '4.5120', 'ckpt_e1.pt'],
      [String(epochs / 2), fmt(hist.mel[Math.floor(epochs / 2) - 1] || mel, 4), fmt(hist.kl[Math.floor(epochs / 2) - 1] || kl, 4), `ckpt_e${epochs / 2}.pt`],
      [String(epochs), fmt(mel, 4), fmt(kl, 4), `ckpt_e${epochs}.pt`],
    ] };
    yield { type: 'metrics', items: [
      { k: 'epochs', v: String(epochs) }, { k: 'final mel', v: fmt(mel, 4) },
      { k: 'final kl', v: fmt(kl, 4) }, { k: 'checkpoints', v: '4' },
    ] };
    this.app.log('训练完成 · ckpt_e20.pt 已产出', 'ok');
  }

  async *genericPrint(code) {
    const strs = [...code.matchAll(/print\(\s*f?["']([^"']*)["']/g)].map((m) => m[1]);
    if (!strs.length) { yield out('# (无输出)', 'dim'); return; }
    for (const s of strs) {
      yield out(s.replace(/\{[^}]*\}/g, (m) => m.slice(1, -1)));
      await sleep(60);
    }
  }
}
