# Qwen Lab · QTTS 原站 + Persistent Kaggle Workbench

本项目现在包含两个可以并存的入口：

1. **QTTS 原站**：来自你保存的 `kaggle/working/voice_cloning.ipynb` 的原始网页、声音库、档案处理、双 Worker、PCM 流和诊断链路。
2. **Persistent Kaggle Workbench**：上一阶段完成的 Notebook / Python / 文件 / Git 工作台，仍然保留。

所有源码都真实写入本仓库；不是只保存在 Kaggle，也不是浏览器缓存里的仿页面。

## 先运行 QTTS 原站

要求：Node.js 22.12+、Python 3.11+、Linux x64（FFmpeg 安装包的平台限制）。

```bash
npm install
npm run qtts:setup
npm run qtts
```

打开预览或 `http://localhost:3000`。服务绑定 `0.0.0.0`，浏览器只使用当前源的相对 API 地址。

- 首次 `qtts:setup` 会在被 `.gitignore` 排除的 `.tools/` 和 `.venv/` 安装本地依赖，不会把 FFmpeg、模型或音频提交到 Git。
- 当前沙盒默认 `QTTS_MOCK=1`，启动原始的两个 Worker 和 Analyst，但不下载 Qwen 权重、不申请 GPU。
- 原站页面会自动完成一次私有授权交换；这是沙盒专用的 `QTTS_AUTO_OPEN=1` 适配，不是公开部署的安全默认值。
- 需要同时打开旧 Workbench 时，使用另一个端口：

```bash
npm run dev -- --port 3001
```

### 当前预览能验证什么

| 能力 | 当前状态 |
| --- | --- |
| 原始 `index.html` / `app.js` / `recorder.js` / 诊断脚本 | 已从 Notebook 解包并做 SHA-256 校验；浏览器资源保持字节一致 |
| 录音参考的网页代码、文件上传、WAV/压缩音频解码 | 原代码保留；上传和 FFmpeg 解码已做端到端测试 |
| 声音库、样本增删、参考处理、候选锚点、档案启用 | 已通过真实 API 流程测试 |
| 直接朗读、分段、停顿、双 Worker 有序 PCM 流、五种质量策略 | 已通过二进制协议和模拟播放器测试 |
| 语音对话 | 原链路保留；没有 DeepSeek key 时会返回明确错误，不会伪造回答 |
| 训练输入快照、逐文件哈希校验、删除 | 已测试；**不是训练执行** |
| 诊断、遥测、脱敏导出、双 Worker 对照 | 已测试；MOCK 下仍明确标记未验证 |

**MOCK 通过不等于真实 Qwen 推理、音色相似度、自然度、物理双 T4、ASR 准确率或训练验收。** 这些仍需要真实权重、相应依赖、GPU/物理设备和真实参考音频。

## 原站源码与沙盒适配层

`tools/import_qtts.py` 只解析 Notebook 的 Python AST 并 `literal_eval` 资源字典，**不执行 Notebook 语句**。每个资源在写入前检查字节数和 SHA-256：

```bash
python3 tools/import_qtts.py --force       # 从当前 Notebook 重新解包（会覆盖原始资源）
python3 tools/import_qtts.py --verify-only # 校验项目内 70 个原始资源
```

目录说明：

```text
qtts/web/                 原始网页与浏览器录音/诊断代码
qtts/py/worker.py         原始 Worker（当前用 QTTS_MOCK=1）
qtts/py/analyst.py        原始上传、参考处理、评估与诊断服务
qtts/py/supervisor.py     原始进程监督器，保持未改动
qtts/go/gateway/          原始 Go 网关及测试，保持未改动
qtts/py/arena_gateway.py  沙盒 Python 异步网关适配器
qtts/py/arena_protocol.py 与原浏览器兼容的帧协议和分段器
qtts/py/arena_supervisor.py 仅替换 gateway 子进程命令的启动适配器
qtts/tools/arena_smoke.py 可重复的原站端到端 smoke 测试
qtts/ASSET-MANIFEST.json  Notebook 与 70 个资源的哈希清单
```

当前 Arena 沙盒无法从 GitHub 的重定向资产主机下载 Go 工具链，因此预览使用 **Python 协议兼容网关**，而不是假装已经编译了 Go。原始 Go 源码仍完整保留；在有 Go 的机器上可以直接运行其原生测试和构建。适配器保留原浏览器 API、私有 Cookie 交换、9 字节客户端帧头、双 Worker 调度、PCM 顺序和诊断字段，网页没有被改写成另一套 UI。

## 配置与真实服务边界

| 环境变量 | 默认值 | 说明 |
| --- | --- | --- |
| `PORT` / `QTTS_GATEWAY_PORT` | `3000` | 原站网关端口 |
| `QTTS_MOCK` | `1`（启动脚本默认） | `1` 为本地数据通路 MOCK；真实推理需按原始 Kaggle 环境准备 |
| `QTTS_MOCK_SPEED` | `3.0` | MOCK 合成速度，不代表真实模型性能 |
| `QTTS_STATE` | `qtts/state` | 私有档案、样本、任务和诊断；默认不入 Git |
| `QTTS_AUTO_OPEN` | `1`（启动脚本默认） | 仅在受信任沙盒开启自动私有入口 |
| `DEEPSEEK_API_KEY` | 空 | 聊天模式的密钥；不要写入 Notebook 或 Git |
| `DEEPSEEK_BASE_URL` | `https://api.deepseek.com` | OpenAI 兼容聊天服务地址 |
| `DEEPSEEK_MODEL` | `deepseek-chat` | 聊天模型名 |
| `QTTS_WORKER_PORTS` | `7001,7002` | 两个 Worker 的本地端口 |
| `QTTS_ANALYST_PORT` | `7010` | Analyst 本地端口 |

真实模型/ASR/声纹模型、CUDA 依赖和权重没有被 `requirements-runtime.txt` 偷偷替换或下载。若要做真实验收，请回到原始 Kaggle 启动器，在其目标 GPU 环境完成依赖、权重、探针和音质测试。

## 可重复验证

先启动 `npm run qtts`，再运行：

```bash
npm run qtts:unit   # 协议、分段器、诊断脱敏和原始 JS 语法
npm run qtts:smoke  # 真实 HTTP / 上传 / 声音库 / PCM / 诊断 smoke
npm run qtts:test   # 上述两组
```

当前 smoke 报告写入被忽略的 `qtts/state/arena-smoke.json`，覆盖 **51 项检查**。测试音频是程序生成的合成信号，仅用于验证数据通路，不是人的声音，也不用于证明音色质量。报告不包含访问口令、Cookie、grant 或私密音频。

旧 Workbench 的验证仍然可用：

```bash
npm test
npm run build
npm audit
```

## Persistent Kaggle Workbench

### 快速开始

```bash
npm install
npm run dev -- --port 3001
```

打开 `http://localhost:3001`。这是轻量的本地 Kaggle 兼容环境，不是 Kaggle 官方服务；可用 GPU、操作系统和 Python 包取决于运行机器。

### 导入完整 Kaggle 代码

1. 点击 **Import Kaggle**，粘贴完整 Python 或上传 `.ipynb` / `.py`。
2. 选择真实目标路径，例如 `working/voice_cloning.ipynb`。
3. 点击 **Import & save**，直接写入项目的 `kaggle/` 目录。
4. 点击 **Commit & push**，显式提交并推送当前 GitHub 分支。

Notebook 支持增删、移动、逐单元格执行、Run all、停止和重启；`Ctrl+S` / `Cmd+S` 保存到磁盘。不同单元格共享持久 Python 内核，支持常见 Shell / pip 形式和 Kaggle 路径映射。

| 代码中的路径 | 项目中的真实路径 | 默认 Git 策略 |
| --- | --- | --- |
| `/kaggle/working` | `kaggle/working` | 代码、Notebook、配置被跟踪 |
| `/kaggle/input` | `kaggle/input` | 除说明文件外均不提交 |

**Import/Save 与 Commit/push 是两个不同操作**：前者只写盘，后者才创建 Git commit 并推送。大型数据集、参考音频、模型权重、Checkpoint 和生成音频默认被 `.gitignore` 排除。

Workbench 的边界：不是完整 IPython/Jupyter，不支持所有 magic 或 Kaggle 在线数据集按钮；不会自动提供 GPU/TPU；长时间训练应先保存 Checkpoint。

## 安全与授权

只处理已获得适当授权的声音。不要用于冒充、欺骗或未经授权的身份模拟；发布合成语音时应明确披露其合成属性。

这个仓库包含能执行 Python/Shell 的实验工作台和能接收私密音频的 QTTS 服务。**不要把它们暴露给不受信任的用户。** 公开部署时关闭 `QTTS_AUTO_OPEN`，使用原始私有入口和独立访问控制；不要把 DeepSeek key、访问口令、私有声音或数据集写入 Notebook、日志或 Git。
