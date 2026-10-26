/** dataview.js — 数据集浏览 + 上传真实音频 */
import { el, fmt, fmtBytes, toast } from './util.js';
import { DATASETS } from './data.js';
import { decodeFile, analyzeAudio, synthesizeSpeech, drawWaveform, drawSpectrogram, play } from './audio.js';

export class DataView {
  constructor(app) {
    this.app = app;
    this.grid = document.getElementById('datasetGrid');
    this.tree = document.getElementById('ddTree');
    this.samples = document.getElementById('ddSamples');
    this.title = document.getElementById('ddTitle');
    this.badge = document.getElementById('ddBadge');
    this.bindUpload();
    this.syncUploaded();
    this.render();
  }

  /** 从本地缓存恢复已上传样本的文件树 */
  syncUploaded() {
    const ups = this.app.state.uploadedSpeakers || [];
    const mine = DATASETS.find((d) => d.id === 'mine');
    if (!ups.length) return;
    mine.mounted = true;
    for (const sp of ups) {
      if (!mine.files.some((f) => f.name === sp.name)) mine.files.push({ name: sp.name + '.wav', size: '—' });
      if (!mine.samples.some((s) => s.name === sp.name + '.wav')) {
        mine.samples.push({ name: sp.name + '.wav', dur: sp.analysis?.duration || 0, sr: 24000, text: '（缓存样本）', analysis: sp.analysis });
      }
    }
    mine.speakers = mine.samples.length;
    mine.hours = +(mine.samples.reduce((a, s) => a + (s.dur || 0), 0) / 3600).toFixed(3);
  }

  bindUpload() {
    const dz = document.getElementById('dropzone');
    const inputs = [document.getElementById('fileUpload'), document.getElementById('fileUpload2')];
    dz.addEventListener('click', () => inputs[0].click());
    inputs.forEach((inp) => inp.addEventListener('change', (e) => this.handleFiles(e.target.files)));
    ['dragenter', 'dragover'].forEach((ev) => dz.addEventListener(ev, (e) => { e.preventDefault(); dz.classList.add('drag'); }));
    ['dragleave', 'drop'].forEach((ev) => dz.addEventListener(ev, (e) => { e.preventDefault(); dz.classList.remove('drag'); }));
    dz.addEventListener('drop', (e) => this.handleFiles(e.dataTransfer.files));

    // 示例音频：直接抓仓库里的 wav，走真实的解码/分析流程
    const loadSample = async (btn, file) => {
      if (!btn) return;
      btn.addEventListener('click', async (e) => {
        e.stopPropagation();
        btn.disabled = true;
        try {
          const res = await fetch(`./assets/samples/${file}`);
          const blob = await res.blob();
          const f = new File([blob], file, { type: 'audio/wav' });
          await this.handleFiles([f]);
        } catch (err) {
          toast('示例音频加载失败：' + file, 'err');
        } finally {
          btn.disabled = false;
        }
      });
    };
    loadSample(document.getElementById('sampleMaleBtn'), 'demo_voice_male.wav');
    loadSample(document.getElementById('sampleFemaleBtn'), 'demo_voice_female.wav');
    document.addEventListener('dragover', (e) => e.preventDefault());
    document.addEventListener('drop', (e) => e.preventDefault());
  }

  async handleFiles(files) {
    const list = Array.from(files || []).filter((f) => f.type.startsWith('audio') || /\.(wav|mp3|m4a|ogg|flac)$/i.test(f.name));
    if (!list.length) { toast('请选择音频文件', 'warn'); return; }
    for (const file of list) {
      try {
        toast(`解码 ${file.name} …`);
        const { samples, sr, duration } = await decodeFile(file);
        const an = analyzeAudio(samples, sr);
        const name = file.name.replace(/\.[^.]+$/, '');
        const id = 'user-' + name.toLowerCase().replace(/[^a-z0-9]+/g, '-') + '-' + Math.random().toString(36).slice(2, 5);
        const colors = ['#20beff', '#ff7ac3', '#8b6cff', '#37d399', '#ffb020', '#ff5c7a'];
        const color = colors[this.app.state.uploadedSpeakers.length % colors.length];

        const spk = {
          id, name, tag: '已上传 · 我的声音', lang: 'auto', color,
          f0: an.f0 || 150,
          formantScale: clampScale(an.f0),
          breath: Math.min(0.85, 0.18 + an.zcr * 2.2),
          brightness: Math.min(0.95, 0.2 + an.centroid / 4000),
          dataset: 'My-Voice-Sample', samples: 1, license: 'local',
          desc: `${file.name} · ${fmt(duration, 2)}s · 已提取音色向量（${an.voiced ? '浊音' : '清音'}）`,
          analysis: an,
          refSamples: samples,
          refSr: sr,
          embedding: an.embedding,
        };
        this.app.state.uploadedSpeakers.push(spk);
        this.app.state.speakerId = id;
        this.app.state.refSamples = samples;
        this.app.state.refSr = sr;
        this.app.state.refName = file.name;
        this.app.state.refAnalysis = an;

        // 加入 My-Voice-Sample 数据集
        const mine = DATASETS.find((d) => d.id === 'mine');
        mine.mounted = true;
        mine.files.push({ name: file.name, size: fmtBytes(file.size) });
        mine.samples.push({
          name: file.name, dur: duration, sr, text: '（上传样本）',
          samples, analysis: an,
        });
        mine.hours = +(mine.hours + duration / 3600).toFixed(3);
        mine.speakers = mine.samples.length;
        mine.size = fmtBytes(this.app.state.uploadedBytes += file.size);
        this.app.state.activeDataset = 'mine';

        this.app.addFile(file.name, Math.round(file.size / 1024), true);
        this.app.markDirty();
        this.render();
        this.app.studio.renderSpeakers();
        this.app.studio.renderDetail();
        toast(`已加载 ${file.name} · F0 ${Math.round(an.f0)}Hz · ${fmt(duration, 2)}s`, 'ok');
      } catch (e) {
        console.error(e);
        toast(`解码失败：${file.name}（格式可能不受浏览器支持）`, 'err');
      }
    }
  }

  render() {
    this.grid.innerHTML = '';
    for (const ds of DATASETS) {
      const active = ds.id === this.app.state.activeDataset;
      const card = el('div', { class: 'ds-card' + (active ? ' is-active' : '') }, [
        el('div', { class: 'ds-ico', text: ds.icon }),
        el('div', { class: 'ds-name', text: ds.name }),
        el('div', { class: 'ds-desc', text: ds.desc }),
        el('div', { class: 'ds-stats' }, [
          el('div', {}, [`${ds.hours}` , el('span', { text: ' h' })]),
          el('div', {}, [`${ds.speakers}`, el('span', { text: ' spk' })]),
          el('div', {}, [`${ds.size}`]),
        ]),
        el('div', { style: { marginTop: '10px' } }, [
          el('span', { class: 'badge ' + (ds.mounted ? 'badge-green' : 'badge-amber'), text: ds.mounted ? 'mounted' : 'not mounted' }),
        ]),
      ]);
      card.addEventListener('click', () => {
        this.app.state.activeDataset = ds.id;
        this.app.markDirty();
        this.render();
      });
      this.grid.appendChild(card);
    }
    this.renderDetail();
  }

  async renderDetail() {
    const ds = DATASETS.find((d) => d.id === this.app.state.activeDataset) || DATASETS[0];
    this.title.textContent = `${ds.icon} ${ds.name}`;
    this.badge.textContent = ds.mounted ? `/kaggle/input · mounted` : 'not mounted';
    this.badge.className = 'badge ' + (ds.mounted ? 'badge-green' : 'badge-amber');

    this.tree.innerHTML = '';
    this.tree.appendChild(el('div', { class: 'node dir', text: `/kaggle/input/${ds.name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}/` }));
    for (const f of ds.files) {
      this.tree.appendChild(el('div', { class: 'node ' + (f.dir ? 'dir' : ''), text: `${f.dir ? '📂' : '🎵'} ${f.name}  ` }, [
        el('span', { class: 'muted', style: { fontSize: '10.5px' }, text: f.size || '' }),
      ]));
    }
    if (!ds.files.length) this.tree.appendChild(el('div', { class: 'node muted', text: '（空 · 拖音频到上方区域上传）' }));

    this.samples.innerHTML = '';
    if (!ds.samples.length) {
      this.samples.appendChild(el('div', { class: 'muted', style: { fontSize: '12px', padding: '10px' }, text: '还没有样本。上传音频后，这里会显示真实波形与频谱。' }));
      return;
    }
    for (const s of ds.samples.slice(0, 8)) {
      const canvas = el('canvas', {});
      const btn = el('button', { class: 'btn btn-ghost sm', text: '▶' });
      const meta = el('div', { class: 'sample-meta' }, [
        el('b', { text: s.name }),
        `${fmt(s.dur, 2)}s · ${s.sr} Hz${s.analysis ? ` · F0 ${Math.round(s.analysis.f0)}Hz · 质心 ${Math.round(s.analysis.centroid)}Hz` : ' · 模拟样本'}`,
      ]);
      const row = el('div', { class: 'sample-row' }, [btn, canvas, meta]);
      btn.addEventListener('click', async () => {
        if (s.samples) { play(s.samples, s.sr); return; }
        // 模拟样本：临时合成一段放出来
        const spk = this.app.getSpeaker();
        const r = synthesizeSpeech({ text: s.text || 'sample audio', speaker: spk, speed: 1, expr: 0.4 });
        play(r.samples, r.sr);
      });
      this.samples.appendChild(row);
      // 波形
      const draw = () => {
        if (s.samples) drawWaveform(canvas, s.samples, { color: '#20beff' });
        else {
          const spk = this.app.getSpeaker();
          const r = synthesizeSpeech({ text: s.text || 'sample', speaker: spk, speed: 1.35, expr: 0.3 });
          drawWaveform(canvas, r.samples, { color: '#3a6ea8' });
        }
      };
      requestAnimationFrame(draw);
    }
  }
}

function clampScale(f0) {
  const v = 1.16 - (Math.min(260, Math.max(85, f0)) - 85) * 0.0016;
  return Math.round(v * 100) / 100;
}
