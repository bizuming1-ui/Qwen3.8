/**
 * 生成示例音频（把合成结果写成 wav，方便在 Data 页拖拽上传做真实解码测试）
 * 运行：node scripts/gen-samples.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { synthesizeSpeech, toWavBlob } from '../src/audio.js';

const OUT = path.join(process.cwd(), 'assets', 'samples');
fs.mkdirSync(OUT, { recursive: true });

const jobs = [
  {
    file: 'demo_voice_male.wav',
    speaker: { id: 'chen', f0: 112, formantScale: 0.95, breath: 0.16, brightness: 0.42 },
    text: '你好，这是示例音频。把它拖进 Data 页面，就能听到克隆后的声音。',
    speed: 1.0, expr: 0.5, pitchShift: 0,
  },
  {
    file: 'demo_voice_female.wav',
    speaker: { id: 'aria', f0: 214, formantScale: 1.16, breath: 0.42, brightness: 0.68 },
    text: 'Hello, this is a demo voice sample for the clone lab.',
    speed: 1.05, expr: 0.7, pitchShift: 0,
  },
];

for (const j of jobs) {
  const r = synthesizeSpeech(j);
  const blob = toWavBlob(r.samples, r.sr);
  const buf = Buffer.from(await blob.arrayBuffer());
  const p = path.join(OUT, j.file);
  fs.writeFileSync(p, buf);
  console.log(`✓ ${j.file} · ${(r.samples.length / r.sr).toFixed(2)}s · ${(buf.length / 1024).toFixed(0)} KB`);
}
