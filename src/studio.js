/** studio.js — Voice Clone Studio：音色选择 + 流水线动画 + 合成试听 */
import { el, fmt, toast, sleep, downloadBlob } from './util.js';
import { SPEAKERS } from './data.js';
import {
  synthesizeSpeech, analyzeAudio, phonemize, drawWaveform, drawSpectrogram,
  play, stop, toWavBlob, cosineSim, SR,
} from './audio.js';
import { radar } from './charts.js';

const profileCache = new Map();
const PROBE = 'The quick brown fox jumps over the lazy dog, and this is a voice clone test.';

/** 为预设音色"录制"一段参考并分析，用于展示音色向量 */
export function getProfile(spk) {
  if (spk.samples && spk.embedding) return spk;
  if (profileCache.has(spk.id)) return profileCache.get(spk.id);
  const r = synthesizeSpeech({ text: PROBE, speaker: spk, speed: 1.05, expr: 0.35 });
  const an = analyzeAudio(r.samples, r.sr);
  const prof = { ...spk, refSamples: r.samples, refSr: r.sr, analysis: an, embedding: an.embedding };
  profileCache.set(spk.id, prof);
  return prof;
}

export class Studio {
  constructor(app) {
    this.app = app;
    this.out = null;
    this.el = {
      list: document.getElementById('speakerList'),
      detail: document.getElementById('speakerDetail'),
      text: document.getElementById('ttsText'),
      synthBtn: document.getElementById('synthesizeBtn'),
      wave: document.getElementById('outWave'),
      spec: document.getElementById('outSpec'),
      metrics: document.getElementById('outMetrics'),
      play: document.getElementById('playBtn'),
      dl: document.getElementById('downloadBtn'),
      phonemes: document.getElementById('phonemes'),
      pipe: document.getElementById('pipeline'),
      pipeStatus: document.getElementById('pipeStatus'),
      charCount: document.getElementById('charCount'),
      modelBadge: document.getElementById('modelBadge'),
    };
    this.bind();
  }

  bind() {
    this.el.text.value = this.app.state.studioText || this.el.text.value;
    this.updateCharCount();
    this.el.text.addEventListener('input', () => {
      this.app.state.studioText = this.el.text.value;
      this.updateCharCount();
      this.app.markDirty();
    });

    const speed = document.getElementById('speed');
    const expr = document.getElementById('expr');
    const pitch = document.getElementById('pitch');
    speed.value = this.app.state.speed;
    expr.value = this.app.state.expr;
    pitch.value = this.app.state.pitchShift;
    const sync = () => {
      document.getElementById('speedVal').textContent = `${fmt(+speed.value, 2)}×`;
      document.getElementById('exprVal').textContent = fmt(+expr.value, 2);
      const p = +pitch.value;
      document.getElementById('pitchVal').textContent = `${p > 0 ? '+' : ''}${p} st`;
      this.app.state.speed = +speed.value;
      this.app.state.expr = +expr.value;
      this.app.state.pitchShift = +pitch.value;
      this.app.markDirty();
    };
    [speed, expr, pitch].forEach((s) => s.addEventListener('input', sync));
    sync();

    this.el.synthBtn.addEventListener('click', () => this.synthesize());
    this.el.play.addEventListener('click', () => {
      if (!this.out) return;
      this.playWithHead();
    });
    this.el.dl.addEventListener('click', () => {
      if (!this.out) return;
      const spk = this.app.getSpeaker();
      downloadBlob(toWavBlob(this.out.samples, this.out.sr), `clone_${spk.id}_${Date.now()}.wav`);
      toast('已导出 WAV', 'ok');
    });
    window.addEventListener('resize', () => {
      if (this.out) this.redraw();
    });
  }

  updateCharCount() {
    this.el.charCount.textContent = `${this.el.text.value.length} chars`;
  }

  renderSpeakers() {
    const list = this.el.list;
    list.innerHTML = '';
    const all = [...SPEAKERS, ...this.app.state.uploadedSpeakers];
    for (const spk of all) {
      const active = spk.id === this.app.state.speakerId;
      const item = el('div', { class: 'speaker-item' + (active ? ' is-active' : '') }, [
        el('div', { class: 'avatar', style: { background: spk.color }, text: spk.name.slice(0, 2).toUpperCase() }),
        el('div', { style: { minWidth: '0' } }, [
          el('div', { class: 'sp-name', text: spk.name }),
          el('div', { class: 'sp-tag', text: `${spk.tag} · ${spk.samples} 条` }),
        ]),
      ]);
      item.addEventListener('click', () => {
        this.app.state.speakerId = spk.id;
        this.app.markDirty();
        this.renderSpeakers();
      });
      list.appendChild(item);
    }
    this.renderDetail();
    this.el.modelBadge.textContent = `checkpoint: ep20 · ${this.app.getSpeaker().name}`;
  }

  renderDetail() {
    const spk = this.app.getSpeaker();
    const prof = getProfile(spk);
    const an = prof.analysis || spk.analysis;
    const host = this.el.detail;
    host.innerHTML = '';
    const canvas = el('canvas', {});
    const facts = el('div', { class: 'sp-facts' }, [
      el('div', {}, [el('span', { text: 'F0 ' }), `${Math.round(an?.f0 || spk.f0)} Hz`]),
      el('div', {}, [el('span', { text: 'formant ' }), `${fmt(spk.formantScale, 2)}×`]),
      el('div', {}, [el('span', { text: 'breath ' }), fmt(spk.breath, 2)]),
      el('div', {}, [el('span', { text: 'dataset ' }), spk.dataset || 'uploaded']),
      el('div', {}, [el('span', { text: 'license ' }), spk.license || 'local']),
    ]);
    host.appendChild(el('div', { class: 'radar-wrap' }, [canvas, facts]));
    host.appendChild(el('p', { class: 'page-sub', style: { marginTop: '10px', fontSize: '11.5px' }, text: spk.desc || '上传的音频样本，已提取 12 维音色向量。' }));
    requestAnimationFrame(() => radar(canvas, (an?.embedding || new Array(12).fill(0)).map((v) => Math.abs(v) + 0.4), { color: spk.color, height: 132 }));
  }

  /* ── 流水线动画 ── */
  async animatePipeline(text) {
    const steps = Array.from(this.el.pipe.querySelectorAll('.pipe-step'));
    steps.forEach((s) => s.classList.remove('active', 'done'));
    this.el.pipeStatus.textContent = 'running';
    this.el.pipeStatus.className = 'badge badge-amber';
    const labels = ['text → tokens', 'grapheme → phoneme', 'text encoder → mel', 'mel refine', 'hifi-gan → wav'];
    for (let i = 0; i < steps.length; i++) {
      steps[i].classList.add('active');
      this.app.setKernelBusy(true, labels[i]);
      if (i === 1) this.el.phonemes.textContent = phonemize(text).join('  ') || '—';
      await sleep(150 + Math.random() * 120);
      steps[i].classList.remove('active');
      steps[i].classList.add('done');
    }
    this.el.pipeStatus.textContent = 'done';
    this.el.pipeStatus.className = 'badge badge-green';
    this.app.setKernelBusy(false);
  }

  async synthesize() {
    if (this.busy) return;
    const text = this.el.text.value.trim();
    if (!text) { toast('请输入要合成的文本', 'warn'); return; }
    const spk = this.app.getSpeaker();
    const a = this.app.state.accelerator;
    this.busy = true;
    this.el.synthBtn.disabled = true;
    this.el.synthBtn.textContent = '合成中…';
    stop();

    if (a === 'cpu') {
      await sleep(500);
      toast('CPU only：合成极慢且需先训好模型，切到 GPU 再试', 'err');
      this.busy = false;
      this.el.synthBtn.disabled = false;
      this.el.synthBtn.textContent = '▶ 合成语音 (inference)';
      this.el.pipeStatus.textContent = 'error';
      this.el.pipeStatus.className = 'badge badge-amber';
      return;
    }

    await this.animatePipeline(text);
    const t0 = performance.now();
    const r = synthesizeSpeech({
      text, speaker: spk,
      speed: this.app.state.speed, expr: this.app.state.expr, pitchShift: this.app.state.pitchShift,
    });
    const ms = performance.now() - t0;
    const an = analyzeAudio(r.samples, r.sr);
    this.setOutput(r.samples, r.sr, an, spk, ms);
    this.busy = false;
    this.el.synthBtn.disabled = false;
    this.el.synthBtn.textContent = '▶ 合成语音 (inference)';
    this.app.log(`studio · 合成 ${fmt(an.duration, 2)}s · RTF ${fmt(ms / 1000 / an.duration, 3)}`, 'ok');
  }

  setOutput(samples, sr, an, spk, ms) {
    this.out = { samples, sr, an, spk };
    this.redraw();
    this.el.play.disabled = false;
    this.el.dl.disabled = false;
    // 音色相似度
    const prof = getProfile(spk);
    const sim = prof.analysis ? cosineSim(an.embedding, prof.analysis.embedding) : 0.9;
    const tiles = [
      ['时长', `${fmt(an.duration, 2)}s`, ''],
      ['F0 基频', `${Math.round(an.f0)} Hz`, ''],
      ['频谱质心', `${Math.round(an.centroid)} Hz`, 'violet'],
      ['音色相似度', `${(Math.max(0, sim) * 100).toFixed(1)}%`, 'green'],
      ['RTF', fmt((ms || 320) / 1000 / Math.max(0.05, an.duration), 3), ''],
      ['采样率', `${sr} Hz`, ''],
    ];
    this.el.metrics.innerHTML = tiles
      .map(([k, v, c]) => `<div class="metric-tile"><div class="mt-k">${k}</div><div class="mt-v ${c}">${v}</div></div>`)
      .join('');
  }

  redraw() {
    if (!this.out) return;
    drawWaveform(this.el.wave, this.out.samples, { color: '#20beff' });
    drawSpectrogram(this.el.spec, this.out.samples, this.out.sr, { maxFreq: 8000 });
  }

  playWithHead() {
    if (!this.out) return;
    const { samples, sr } = this.out;
    const dur = samples.length / sr;
    const t0 = performance.now();
    const btn = this.el.play;
    btn.textContent = '■ Stop';
    let raf = 0;
    const tick = () => {
      const p = Math.min(1, (performance.now() - t0) / 1000 / dur);
      drawWaveform(this.el.wave, samples, { color: '#20beff', playhead: p });
      if (p < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    play(samples, sr, () => {
      cancelAnimationFrame(raf);
      btn.textContent = '▶ Play';
      drawWaveform(this.el.wave, samples, { color: '#20beff' });
    });
  }
}
