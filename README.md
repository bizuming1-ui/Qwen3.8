# 🎙️ Kaggle Simulator · Voice Clone Lab

一个**纯前端、零依赖**的 Kaggle Notebook 模拟器，专门为「声音克隆 / TTS 项目」打造：
在不花 GPU 配额、不等排队的情况下，把 Kaggle 上从 `!nvidia-smi` 到「克隆出声音」的整条流程完整走一遍。

> 打开即用：`npm run dev` → http://localhost:5173

![views](https://img.shields.io/badge/views-Notebook%20%2F%20Data%20%2F%20Studio%20%2F%20Runs-20beff) ![deps](https://img.shields.io/badge/dependencies-0-37d399)

---

## ✨ 它能做什么

### 📓 Notebook（模拟内核）
11 个真实单元格，点 ▶ 就能跑，输出是**写在浏览器里**的：

| 单元格 | 模拟内容 |
|---|---|
| `!nvidia-smi` | 按 Accelerator 输出 2×T4 / P100 / TPU / CPU 的显卡表；CPU 时正确报 `No devices were found` |
| `import torch` | `torch 2.3.1+cu121 / cuda Tesla T4 / cudnn 8907`；非 GPU 环境抛真实 Traceback |
| `!pip install TTS librosa` | **Internet 开关关掉就下载失败**（和 Kaggle 一致），开着重试、进度条、成功提示 |
| `os.walk(DATA)` | 输出 `/kaggle/input/...` 目录树与文件数 |
| `torchaudio.load + plot_waveform` | 真实生成波形并画 matplotlib 风格图 |
| `display(Audio(...))` | 可在浏览器里播放的音频控件 |
| 训练循环 | 20 epoch 的 tqdm 进度、loss 下降、checkpoint 落盘（侧栏文件树同步新增） |
| `!ls -lh` | 读取「工作目录」真实文件列表 |
| `.synthesize(text, speaker_wav)` | 走 G2P → mel → HiFi-GAN 提示，产出**可听**音频 + 指标 |

支持 Run All（`Shift+Ctrl+Enter`）、单格运行（`Shift+Enter`）、加/删/移动单元格、Markdown 单元格双击编辑、Python 语法高亮、执行计数、耗时。

### 🎧 Data（数据集 + 上传）
- 内置 LJSpeech-1.1 / VCTK-0.92 / LibriTTS-clean 的元数据浏览（文件树、样本列表、迷你波形）
- **上传真实音频**：拖拽或点上传，走 `AudioContext.decodeAudioData` 真解码，再做 FFT 分析
- 仓库自带两个可直接用的示例：`assets/samples/demo_voice_male.wav` / `demo_voice_female.wav`

### 🎙 Voice Clone Studio（核心）
- 5 个预设音色 + 你上传的音频，自动提取 **12 维音色向量** 并画雷达图
- 语速 / 情感强度 / 音高偏移 三个滑杆，实时影响合成结果
- 5 步流水线动画：`Text → G2P → Acoustic → Mel → Vocoder`，音素序列可见
- 产出：波形（带播放头）、**频谱图**、F0 / 频谱质心 / RTF / 音色相似度指标、WAV 导出

### 📈 Experiments（训练实验）
- 配置 model / dataset / epochs / batch / lr / precision
- 真实随机过程的 train+val loss 曲线、逐 epoch 日志、GPU 显存、进度条
- 训练产出 checkpoint 落进文件树，一键「发布到 Studio」

---

## 🔬 它不是"假动画"：音频是真的算出来的

`src/audio.js` 实现了完整的源-滤波器（source-filter）语音合成：

1. **文本 → 音节**：汉字映射到伪拼音音素、英文按元音切分，标点转停顿
2. **声门源**：Rosenberg 脉冲串，f0 由音色的基频 + 音高偏移 + 句中下倾 + 重音 + 询问语调 + jitter/vibrato 决定
3. **共振峰滤波**：4 级 Klatt 式谐振器级联，F1/F2/F3 按元音（a/e/i/o/u…）在样本间插值
4. **气声/摩擦音/爆破音**：噪声源按辅音类型注入，气声比例由音色的 `breath` 控制
5. **后处理**：去直流、归一化、首尾淡入淡出

配套的**分析**部分也是真算的：自相关估计 F0、Hann 窗 STFT、梅尔带对数能量得到 12 维音色向量、余弦相似度做"克隆相似度"。

所以：**上传一个音高 200Hz 的样本，克隆出来的声音基频就会落在 200Hz 附近**——这不是贴图。

---

## 📥 把你的真实 Kaggle 代码放进项目

不想只在「模拟器」里改，而是想让**真正在 Kaggle 跑的那份 notebook** 成为项目的一部分：

```bash
# 1. 把文件放进 kaggle/（或任意位置）
cp ~/Downloads/my_voice_clone.ipynb kaggle/

# 2. 一条命令导入：解析 → 生成 src/kaggle-code.js
npm run import:kaggle -- kaggle/my_voice_clone.ipynb
```

导入后：

- `kaggle/my_voice_clone.ipynb` —— 原始文件，**完整保留、进 Git**，永远不丢
- `src/kaggle-code.js` —— 自动生成的单元格数据（含导入时间、来源、统计）
- 刷新页面，Notebook 默认就加载你的真实代码，标题旁出现 `真实代码 · N code cells` 徽标

也可以完全在界面里操作：

| 按钮 | 作用 |
|---|---|
| **⬆ Import .ipynb**（Notebook 右上） | 选 `.ipynb` / `.py` / `.txt`，直接替换当前 notebook 并本地保存 |
| **⤓ Export** | 把当前 notebook 导出成标准 `.ipynb`，可直接拖回 Kaggle 运行 |
| **↺ 载入 Kaggle 代码**（侧栏） | 重新从 `kaggle/` 加载真实代码 |
| **↺ 载入示例 notebook**（侧栏） | 回到内置的示例流程 |

格式支持：`.ipynb`（JSON cells）、`.py`（按 `# %%` / `# In[ ]` 分节）、`.txt`/`.md`（整段）。

### 真实代码怎么"跑"？

`src/minipy.js` 是个极简 Python 语义模拟器：维护变量表、求值 `print(...)`（含 f-string）、
内置 `torch` / `numpy` / `os` / `librosa` / `soundfile` 桩（`torch.cuda.is_available()` 会真的按你选的 Accelerator 返回），
并把 Python 三元表达式、`and/or/not`、`True/False/None` 翻译成 JS 再求值。

所以像这样的代码能给出像样的输出：

```python
import torch
device = "cuda" if torch.cuda.is_available() else "cpu"
print(f"using device: {device}")     # → using device: cuda
print(len(os.listdir(DATA)))         # → 真实目录结构里的条目数
```

它**不会真的执行你的 Python**（浏览器里没有 Python），也不会运行 `def`/`for` 的函数体；
`nvidia-smi`、`pip install`、训练循环、`synthesize()` 这些则由模拟内核专门接管。

## 🚀 使用

```bash
npm run dev          # 起本地服务（零依赖，node server.cjs）
# 或者直接双击 index.html（ES Module 需要 http 协议，用服务更稳）

npm run gen:samples  # 重新生成示例 wav
```

无 npm 依赖、无构建步骤。文件结构：

```
index.html              界面骨架
assets/style.css        主题样式（深色 Kaggle 风）
assets/samples/*.wav    可上传的示例音频
src/main.js             应用装配（状态 / 顶栏 / 仪表 / 文件树）
src/kernel.js           模拟内核：解释单元格、产出流式事件
src/notebook.js         单元格渲染 + 执行 + 输出组件
src/audio.js            FFT / 解码 / 分析 / 共振峰合成 / 绘图
src/charts.js           折线、波形、雷达、柱状图
src/studio.js           声音克隆实验台
src/dataview.js         数据集与上传
src/runs.js             训练实验
src/data.js             音色库 / 数据集 / 初始 notebook 内容
server.cjs              零依赖静态服务器
```

状态（单元格、上传的音色向量、实验记录）自动存 `localStorage`，刷新不丢。

---

## 🧩 想接真实后端？

模拟内核的入口只有一个：`src/kernel.js` 的 `async *run(source)`，它以 **async generator** 逐个 yield 事件：

```js
{ type: 'stream', text, cls, cr }   // 文本输出（cr = 覆盖当前行，模拟 tqdm）
{ type: 'fig', id, draw, caption }  // canvas 绘图
{ type: 'audio', samples, sr }      // 音频控件
{ type: 'table' | 'metrics' | 'error' }
```

把 `run()` 换成对真实 Kaggle Kernel API / 你的推理服务（如 `POST /tts`）的调用、把上面几种事件映射回来，前端一行都不用改。

---

## ⚠️ 说明

本项目的「Kaggle」界面是**教学/演示用的模拟环境**，与 Google 无关；音频为浏览器内实时合成（Formant synthesis），用于验证流程与交互，音质不等于真实神经网络 TTS 模型。
