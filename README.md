# Qwen Lab · Persistent Kaggle Workbench

一个用于语音克隆实验的、真实写入 Git 仓库的 Kaggle 风格浏览器工作台。它不是把代码放进浏览器缓存，也不是另一个只保存在 Kaggle 上的 Notebook：**Save 会直接写入本项目的 `kaggle/` 目录，Commit & push 会提交并推送到 GitHub。**

> 这是轻量的本地 Kaggle 兼容环境，不是 Kaggle 官方服务。可用 GPU、操作系统和 Python 包取决于运行本项目的机器。仓库目前不包含任何特定的语音克隆模型；请通过 **Import Kaggle** 导入你正在开发的完整代码。

## 快速开始

要求：Node.js 22.12+ 和 Python 3。

```bash
npm install
npm run dev -- --port 3000
```

打开 `http://localhost:3000`。服务绑定 `0.0.0.0`，因此也适用于容器和 Arena 浏览器预览。前端使用相对 API 地址，不需要把浏览器请求指向另一个 localhost 端口。

生产模式：

```bash
npm run build
npm start
```

## 导入你的完整 Kaggle 代码

1. 点击顶栏或文件栏的 **Import Kaggle**。
2. 选择 **Paste code** 粘贴完整 Python 代码，或选择 **Upload file** 上传已有 `.ipynb` / `.py`。
3. 选择真实目标路径：
   - `working/voice_cloning.ipynb`：保存为 Jupyter Notebook；Python 的 `# %%` 和 `# %% [markdown]` 分段自动转换为单元格。
   - `working/main.py`：保留为普通 Python 脚本。
4. 点击 **Import & save**。这一步已经写入项目文件，刷新浏览器不会丢失。
5. 点击 **Commit & push**，确认提交信息后推送到当前 GitHub 分支。

也可以直接在 Notebook 中增删、移动和执行单元格。`Ctrl+S` / `Cmd+S` 是磁盘保存快捷键。

## 两级持久化，语义明确

| 操作 | 结果 |
| --- | --- |
| **Import & save / Save** | 原子写入当前仓库的真实文件；不会自动创建 Git commit |
| **Commit & push** | 先保存当前编辑器，再仅暂存 `kaggle/working`，提交并执行 `git push origin <当前分支>` |
| 刷新浏览器 | 重新从项目磁盘读取文件，不从 IndexedDB 或 localStorage 恢复源代码 |

Git 同步不会自动提交其他已暂存文件；如果检测到工作区之外的暂存内容，会停止并显示说明。若 commit 成功而 push 因网络失败，再次同步即可推送已有 commit。

## Kaggle 目录映射

| 代码中的路径 | 项目中的真实路径 | 默认 Git 策略 |
| --- | --- | --- |
| `/kaggle/working` | `kaggle/working` | 代码、Notebook、配置被跟踪 |
| `/kaggle/input` | `kaggle/input` | 除说明文件外均不提交 |

执行时，Python AST 中的 `/kaggle/working...` 和 `/kaggle/input...` 字符串会映射到上述真实目录，**磁盘上的源代码不会被改写**。运行目录默认为 `kaggle/working`，同时设置 `KAGGLE_WORKING_DIR` 和 `KAGGLE_INPUT_DIR` 环境变量。

大型数据集、参考音频、模型权重、Checkpoint 和生成音频默认被 `.gitignore` 排除。请单独备份数据；不要为了同步代码而把私人声音或许可受限的数据上传 GitHub。

## 已实现的 Kaggle 风格能力

- 持久 Python 内核：不同单元格共享变量、函数和已导入模块。
- Notebook / 脚本编辑、逐单元格运行、Run all、停止和重启内核。
- 标准输出、标准错误、最后表达式结果和异常显示。
- 读取已有 Notebook 的文本、图片和音频输出；音频可在浏览器中播放。
- 常见 `!shell`、`!pip install ...`、`%pip install ...` 和 `%cd ...` 形式。
- 真实文件树、新建/删除、下载、Notebook 导入和导出。
- Git 分支、变更和最后提交状态；显式提交并推送。

### 边界

- 不是完整 IPython/Jupyter：不支持所有 magic、交互式 `input()` 或 Kaggle 在线数据集按钮。
- `pip` 安装的包位于当前机器环境；建议重要项目另外固定依赖版本。
- GPU/TPU 不会由模拟器自动提供。训练前请在本机检查 `torch.cuda.is_available()` 等条件。
- 默认单次执行超时为 10 分钟，可通过 `EXECUTION_TIMEOUT_MS` 调整。停止或重启会清空内核变量。
- 长时间训练应先保存 Checkpoint；浏览器输出不是训练日志的唯一备份。

## 语音克隆代码迁移建议

1. 把完整代码导入 `working/voice_cloning.ipynb`，先逐段运行环境检查、依赖安装和数据检查，不要直接 Run all 一个长训练流程。
2. 把授权的数据和参考音频放入 `kaggle/input/`，或在 Notebook 中使用你已验证的下载方式。
3. 将中间产物放入 `outputs/`、`checkpoints/`、`runs/` 或 `models/`；这些目录默认不上传 GitHub。
4. 固定依赖版本，记录样本率、模型配置、随机种子和训练参数，确保结果可复现。
5. 先确认小样本推理，再启动长时间训练。生成的音频可下载，或通过 Notebook 已有音频输出播放。

**只处理已获得适当授权的声音。不要用于冒充、欺骗或未经授权的身份模拟；发布或发送合成语音时应明确披露其合成属性。**

## 配置

| 环境变量 | 默认值 | 用途 |
| --- | --- | --- |
| `PORT` | `3000` | Web 服务端口 |
| `PYTHON_BIN` | `python3` | Python 可执行文件，可指向虚拟环境 |
| `EXECUTION_TIMEOUT_MS` | `600000` | 单次单元格/脚本执行超时 |
| `GIT_AUTHOR_NAME` | `Kaggle Workbench` | 浏览器同步时的 commit author |
| `GIT_AUTHOR_EMAIL` | `kaggle-workbench@localhost` | 浏览器同步时的 author email |

例如使用项目虚拟环境：

```bash
python3 -m venv .venv
source .venv/bin/activate
PYTHON_BIN="$PWD/.venv/bin/python" npm run dev
```

## 验证

```bash
npm test          # Notebook 转换和路径安全测试
npm run build     # TypeScript 检查和生产构建
npm audit         # 依赖安全检查
```

项目还验证了 API 文件写入/读取、持久内核、Kaggle 路径映射、Shell 命令和路径穿越防护。

## 结构

```text
server/                 Express API、真实文件操作、Git 同步、Python 内核
src/                    React 工作台、Notebook 编辑器、导入和同步界面
kaggle/working/         需要进入 Git 的实验代码和 Notebook
kaggle/input/           默认本地-only 的数据与授权参考音频
```

## 安全说明

这个工作台按开发工具设计，能够执行你粘贴的任意 Python/Shell 代码并操作工作区文件。**不要把它暴露给不受信任的用户，不要在公开部署中开放执行或 Git 推送 API，也不要把凭证、私有声音或数据集写入 Notebook。** 在运行第三方语音克隆代码前，应先审查其安装和下载命令。
