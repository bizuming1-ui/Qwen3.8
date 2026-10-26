/** data.js — 模拟数据：音色库、数据集、初始 notebook */
import { KAGGLE_CELLS, KAGGLE_SOURCE } from './kaggle-code.js';

export const SPEAKERS = [
  {
    id: 'chen', name: 'Chen Shu', tag: '男声 · 播音', lang: 'zh-CN', color: '#20beff',
    f0: 112, formantScale: 0.95, breath: 0.16, brightness: 0.42,
    dataset: 'VCTK-0.92', samples: 412, license: 'CC-BY-4.0',
    desc: '低沉平稳的男声播报风格，低频厚实。',
  },
  {
    id: 'aria', name: 'Aria', tag: '女声 · 叙述', lang: 'en-US', color: '#ff7ac3',
    f0: 214, formantScale: 1.16, breath: 0.42, brightness: 0.68,
    dataset: 'LJSpeech-1.1', samples: 13100, license: 'Public Domain',
    desc: '明亮清透的英文女声，气声比例高。',
  },
  {
    id: 'kenji', name: 'Kenji', tag: '男中音 · 日语', lang: 'ja-JP', color: '#8b6cff',
    f0: 138, formantScale: 1.0, breath: 0.24, brightness: 0.52,
    dataset: 'LibriTTS-clean', samples: 2600, license: 'CC-BY-4.0',
    desc: '中性男中音，节奏偏快，齿音清晰。',
  },
  {
    id: 'xiaomai', name: '小麦', tag: '少女音 · 中文', lang: 'zh-CN', color: '#37d399',
    f0: 262, formantScale: 1.22, breath: 0.5, brightness: 0.76,
    dataset: 'VCTK-0.92', samples: 388, license: 'CC-BY-4.0',
    desc: '轻快少女音，音高高、气声明显。',
  },
  {
    id: 'meera', name: 'Meera', tag: '女声 · 印地口音', lang: 'en-IN', color: '#ffb020',
    f0: 196, formantScale: 1.1, breath: 0.3, brightness: 0.6,
    dataset: 'LibriTTS-clean', samples: 1140, license: 'CC-BY-4.0',
    desc: '中低女声，元音饱满，重音明显。',
  },
];

export const DATASETS = [
  {
    id: 'ljspeech', name: 'LJSpeech-1.1', icon: '📚',
    desc: '单说话人英文语音库，13,100 条短音频，22.05kHz。',
    hours: 23.9, speakers: 1, size: '2.6 GB', mounted: true,
    files: [
      { name: 'metadata.csv', size: '1.3 MB' },
      { name: 'wavs/', dir: true, size: '12500 files' },
      { name: 'ref/spk01.wav', size: '282 KB' },
      { name: 'train.txt', size: '1.1 MB' },
      { name: 'val.txt', size: '58 KB' },
    ],
    samples: [
      { name: 'LJ001-0001.wav', dur: 3.42, sr: 22050, text: 'Printing, in the only sense with which we are at present concerned.' },
      { name: 'LJ001-0007.wav', dur: 2.18, sr: 22050, text: 'In the last few years, however, the subject has been much discussed.' },
      { name: 'ref/spk01.wav', dur: 3.05, sr: 22050, text: '参考音频（3s reference）' },
    ],
  },
  {
    id: 'vctk', name: 'VCTK-0.92', icon: '🎙',
    desc: '109 位不同口音的英文说话人，适合多说话人 / 音色迁移。',
    hours: 44, speakers: 109, size: '10.8 GB', mounted: true,
    files: [
      { name: 'txt/p225/', dir: true, size: '400 files' },
      { name: 'wav48_silence_trimmed/', dir: true, size: '44313 files' },
      { name: 'speaker-info.txt', size: '6 KB' },
      { name: 'ref/p225_001_mic1.flac', size: '96 KB' },
    ],
    samples: [
      { name: 'p225_001_mic1', dur: 2.86, sr: 48000, text: 'Please call Stella.' },
      { name: 'p234_002_mic2', dur: 3.91, sr: 48000, text: 'Ask her to bring these things with her from the store.' },
      { name: 'p294_019_mic1', dur: 4.12, sr: 48000, text: 'We also need a small plastic snake and a big toy frog.' },
    ],
  },
  {
    id: 'libritts', name: 'LibriTTS-clean', icon: '📖',
    desc: 'LibriSpeech 的 TTS 重制版，多说话人、干净标注。',
    hours: 585, speakers: 2464, size: '58 GB', mounted: true,
    files: [
      { name: 'train-clean-100/', dir: true, size: '33k files' },
      { name: 'dev-clean/', dir: true, size: '5.7k files' },
      { name: 'speakers.txt', size: '24 KB' },
    ],
    samples: [
      { name: '84-121123-0000', dur: 5.02, sr: 24000, text: 'The Assizes were held at Exeter.' },
      { name: '103-1240-0001', dur: 4.41, sr: 24000, text: 'He was a heavy, dark, silent man.' },
    ],
  },
  {
    id: 'mine', name: 'My-Voice-Sample', icon: '👤',
    desc: '你上传的音频会出现在这里，可直接作为克隆目标音色。',
    hours: 0, speakers: 0, size: '0 B', mounted: false, dynamic: true,
    files: [], samples: [],
  },
];

const DEMO_CELLS = [
  {
    type: 'md',
    source: '## 🎙️ Voice Clone Lab\nZero-shot voice cloning on Kaggle GPU：3 秒参考音频即可克隆音色。\n模型：**VITS** + **HiFi-GAN** · 数据集：LJSpeech-1.1 / VCTK',
  },
  { type: 'code', source: '!nvidia-smi' },
  {
    type: 'code',
    source:
      'import os, torch, torchaudio, numpy as np\nprint("torch", torch.__version__)\nprint("cuda", torch.cuda.get_device_name(0))\nprint("cudnn", torch.backends.cudnn.version())',
  },
  { type: 'code', source: '!pip install -q TTS==0.22.0 librosa soundfile' },
  {
    type: 'code',
    source:
      '# 挂载数据集\nDATA = "/kaggle/input/ljspeech-1-1"\nfor root, dirs, files in os.walk(DATA):\n    print(root, len(files))',
  },
  {
    type: 'code',
    source:
      'import matplotlib.pyplot as plt\nwav, sr = torchaudio.load(f"{DATA}/ref/spk01.wav")\nprint(wav.shape, sr)\nplot_waveform(wav, sr)',
  },
  {
    type: 'code',
    source: 'from IPython.display import Audio, display\ndisplay(Audio(wav.numpy(), rate=sr))',
  },
  {
    type: 'md',
    source: '### Train 训练\nVITS + HiFi-GAN, 20 epochs, fp16 on GPU。训练日志会实时输出。',
  },
  {
    type: 'code',
    source:
      'model = VITS(num_chars=256, spec_channels=513).cuda()\nopt = torch.optim.AdamW(model.parameters(), lr=2e-4)\nfor epoch in range(1, 21):\n    for batch in train_loader:\n        loss = model(batch)\n        loss.backward(); opt.step(); opt.zero_grad()\n    print(f"epoch {epoch} loss {loss.item():.4f}")\n    save_checkpoint(model, f"/kaggle/working/ckpt_e{epoch}.pt")',
  },
  { type: 'code', source: '!ls -lh /kaggle/working' },
  {
    type: 'code',
    source:
      '# 推理：用参考音频克隆音色\nsynth = model.synthesize(\n    text="你好，这是我的克隆声音。",\n    speaker_wav=f"{DATA}/ref/spk01.wav",\n)\ndisplay(Audio(synth, rate=24000))',
  },
];

export const ACCELERATORS = {
  t4x2: { label: 'GPU T4 ×2', gpus: [['Tesla T4', 15360], ['Tesla T4', 15360]], vramTotal: 30.7, flavor: 'gpu', cuda: '12.1' },
  p100: { label: 'GPU P100', gpus: [['Tesla P100-PCIE-16GB', 16384]], vramTotal: 16, flavor: 'gpu', cuda: '12.1' },
  tpu: { label: 'TPU VM v3-8', gpus: [], vramTotal: 0, flavor: 'tpu', cuda: '—' },
  cpu: { label: 'CPU only', gpus: [], vramTotal: 0, flavor: 'cpu', cuda: '—' },
};

/** 若项目里导入过真实 Kaggle 代码，默认就用它，否则用示例 */
export const NOTEBOOK_CELLS = KAGGLE_CELLS && KAGGLE_CELLS.length ? KAGGLE_CELLS : DEMO_CELLS;
export { DEMO_CELLS, KAGGLE_CELLS, KAGGLE_SOURCE };
