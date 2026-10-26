/** runs.js — 训练实验管理（模拟 loss 曲线 / 日志 / checkpoint） */
import { el, fmt, toast, gauss, rng, sleep } from './util.js';
import { lineChart } from './charts.js';

export class RunsManager {
  constructor(app) {
    this.app = app;
    this.running = false;
    this.els = {
      model: document.getElementById('cfgModel'),
      dataset: document.getElementById('cfgDataset'),
      epochs: document.getElementById('cfgEpochs'),
      batch: document.getElementById('cfgBatch'),
      lr: document.getElementById('cfgLr'),
      prec: document.getElementById('cfgPrec'),
      start: document.getElementById('startRunBtn'),
      status: document.getElementById('runStatus'),
      progress: document.getElementById('runProgress'),
      progressText: document.getElementById('runProgressText'),
      chart: document.getElementById('lossChart'),
      stats: document.getElementById('runStats'),
      log: document.getElementById('runLog'),
      table: document.getElementById('runsTable'),
      count: document.getElementById('runCountBadge'),
    };
    this.els.start.addEventListener('click', () => this.start());
    this.renderTable();
    this.drawIdleChart();
  }

  drawIdleChart() {
    lineChart(this.els.chart, {
      series: [{ data: [], color: '#20beff', label: 'train' }],
      yMin: 0, yMax: 10, xMax: 20, xLabel: 'epoch', yLabel: 'loss', height: 200,
      title: 'loss curve · 等待训练开始',
    });
  }

  logLine(text, cls = '') {
    const t = this.els.log;
    const span = document.createElement('span');
    span.className = cls;
    span.textContent = text + '\n';
    t.appendChild(span);
    t.scrollTop = t.scrollHeight;
  }

  async start() {
    if (this.running) { toast('已有训练在跑', 'warn'); return; }
    const epochs = Math.max(1, Math.min(200, +this.els.epochs.value || 20));
    const model = this.els.model.value;
    const dataset = this.els.dataset.value;
    const batch = +this.els.batch.value || 16;
    const lr = +this.els.lr.value || 2e-4;
    const prec = this.els.prec.value;
    const accel = this.app.state.accelerator;

    if (accel === 'cpu') { toast('CPU only 训练会非常慢（演示仍会跑完）', 'warn'); }
    if (dataset === 'My-Voice-Sample' && !this.app.state.uploadedSpeakers.length) {
      toast('My-Voice-Sample 为空：先到 Data 页上传音频', 'err');
      return;
    }
    if (!this.app.state.internet && model === 'tacotron2') {
      toast('Internet 关闭：无法下载预训练权重，已退化为随机初始化', 'warn');
    }

    this.running = true;
    this.els.start.disabled = true;
    this.els.log.innerHTML = '';
    this.els.status.textContent = 'running';
    this.els.status.className = 'badge badge-amber';
    this.app.setKernelBusy(true, 'Training…');

    const speedMul = accel === 'cpu' ? 2.2 : accel === 'p100' ? 1.35 : accel === 'tpu' ? 0.7 : 1;
    const msPerEpoch = Math.max(38, Math.round(90 * speedMul));

    this.logLine(`$ python train.py --model ${model} --dataset ${dataset} --epochs ${epochs} --batch ${batch} --lr ${lr} --precision ${prec}`, '');
    this.logLine(`[device] ${accel.toUpperCase()} · ${prec} · gradient_checkpointing=True`);
    this.logLine(`[data] ${dataset} ready · dataloader workers=4`);
    this.logLine(`[model] ${model === 'vits' ? 'VITS (12.4M params)' : model === 'tacotron2' ? 'Tacotron2 (28.1M) + HiFi-GAN (13.9M)' : 'FastSpeech2 (22.6M) + HiFi-GAN'}`, 'ok');
    await sleep(200);

    const r = rng(Date.now() % 100000);
    let mel = 8.4, val = 8.9;
    const trainArr = [], valArr = [];
    this.els.progress.style.width = '0%';
    this.els.progressText.textContent = `0% · 0/${epochs}`;

    for (let e = 1; e <= epochs; e++) {
      mel = Math.max(0.33, mel * (0.855 + gauss(r) * 0.014));
      val = Math.max(0.46, mel * 1.16 + Math.abs(gauss(r)) * 0.05);
      trainArr.push(mel); valArr.push(val);

      if (e === 1 || e % Math.max(1, Math.round(epochs / 6)) === 0 || e === epochs) {
        this.logLine(`epoch ${String(e).padStart(3)}/${epochs}  mel ${mel.toFixed(4)}  val ${val.toFixed(4)}  gpu_mem ${(6.2 + r() * 3).toFixed(1)}G  ${(1400 + r() * 400).toFixed(0)}ms/step`);
      }
      if (e % Math.max(5, Math.round(epochs / 4)) === 0 || e === epochs) {
        this.logLine(`  → saved /kaggle/working/ckpt_e${e}.pt (${(49.6 + r() * 0.2).toFixed(1)} MB)`, 'ok');
        this.app.addFile(`ckpt_e${e}.pt`, 50790);
      }

      const pct = e / epochs;
      this.els.progress.style.width = `${pct * 100}%`;
      this.els.progressText.textContent = `${Math.round(pct * 100)}% · ${e}/${epochs}`;
      this.app.setRunProgress(pct);
      this.app.ramBump(pct);

      lineChart(this.els.chart, {
        series: [
          { data: trainArr, color: '#20beff', label: 'train mel', fill: true },
          { data: valArr, color: '#ffb020', label: 'val mel', dashed: true },
        ],
        yMin: 0, yMax: Math.max(2, trainArr[0]), xMax: epochs,
        xLabel: 'epoch', yLabel: 'loss', height: 200,
        title: `loss · ${model} · ${dataset}`,
      });

      this.els.stats.innerHTML = [
        ['epoch', `${e}/${epochs}`],
        ['mel_loss', mel.toFixed(4)],
        ['val_loss', val.toFixed(4)],
        ['gpu_mem', `${(6.2 + r() * 3).toFixed(1)}G`],
        ['lr', lr.toExponential(2)],
      ].map(([k, v]) => `<span class="stat-pill">${k} <b>${v}</b></span>`).join('');

      await sleep(msPerEpoch);
    }

    const acc = 0.86 + Math.min(0.1, epochs / 400);
    this.logLine(`✓ training finished · best val ${Math.min(...valArr).toFixed(4)} · ${epochs} epochs`, 'ok');
    this.els.status.textContent = 'finished';
    this.els.status.className = 'badge badge-green';
    this.app.markSaved();

    const run = {
      id: 'run-' + Math.random().toString(36).slice(2, 7),
      model: this.els.model.selectedOptions[0].textContent,
      dataset, epochs, mel: +mel.toFixed(4), val: +Math.min(...valArr).toFixed(4),
      acc,
      date: new Date().toLocaleString('zh-CN', { hour12: false }),
      status: 'finished',
      ckpt: `ckpt_e${epochs}.pt`,
      published: false,
    };
    this.app.state.runs.unshift(run);
    this.app.state.runs = this.app.state.runs.slice(0, 8);
    this.running = false;
    this.els.start.disabled = false;
    this.app.setKernelBusy(false);
    this.app.setRunProgress(0);
    this.renderTable();
    toast(`训练完成 · best val ${run.val}`, 'ok');
  }

  publish(run) {
    run.published = true;
    this.app.state.modelEpoch = run.epochs;
    const badge = document.getElementById('modelBadge');
    if (badge) badge.textContent = `checkpoint: ep${run.epochs} · 已就绪`;
    this.app.state.files.push({ name: run.ckpt, size: 50790 });
    this.app.renderFiles();
    this.renderTable();
    this.app.markSaved();
    toast(`已发布 ${run.ckpt} 到 Studio`, 'ok');
  }

  renderTable() {
    const runs = this.app.state.runs || [];
    this.els.count.textContent = runs.length;
    const t = this.els.table;
    if (!runs.length) {
      t.innerHTML = `<tbody><tr><td class="empty">还没有训练记录。配置左侧参数后点 Start training。</td></tr></tbody>`;
      return;
    }
    t.innerHTML =
      `<thead><tr><th>run</th><th>model</th><th>dataset</th><th>epochs</th><th>mel</th><th>val</th><th>acc</th><th>checkpoint</th><th>状态</th><th></th></tr></thead>` +
      `<tbody>${runs.map((r, i) => `
        <tr>
          <td class="mono">${r.id}</td>
          <td>${r.model}</td>
          <td class="mono">${r.dataset}</td>
          <td class="mono">${r.epochs}</td>
          <td class="mono">${r.mel}</td>
          <td class="mono">${r.val}</td>
          <td class="mono" style="color:#6ee7b7">${(r.acc * 100).toFixed(1)}%</td>
          <td class="mono" style="font-size:11px">${r.ckpt}</td>
          <td><span class="badge ${r.published ? 'badge-green' : 'badge-blue'}">${r.published ? '已发布' : r.status}</span></td>
          <td>${r.published ? '' : `<button class="btn btn-ghost sm" data-pub="${i}">发布</button>`}</td>
        </tr>`).join('')}</tbody>`;
    t.querySelectorAll('[data-pub]').forEach((b) => {
      b.addEventListener('click', () => this.publish(runs[+b.dataset.pub]));
    });
  }
}
