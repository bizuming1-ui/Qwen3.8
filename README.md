# Qwen3.8 Voice Lab

一个无外部依赖的 Kaggle 风格本地 Notebook 工作台，供语音克隆实验代码整理和静态环境预检使用。**粘贴进来的代码可以真实保存在本 Git 项目中，不会只留在 Kaggle 或浏览器缓存里。**

## 启动

需要 Python 3.10 或更新版本；无需 `pip install`：

```bash
python3 server.py
```

默认打开 `http://localhost:8000`。服务绑定到 `0.0.0.0`，也可通过 `PORT` 环境变量指定端口：

```bash
PORT=8080 python3 server.py
```

## 保存和导入

1. 在 Notebook 工作台粘贴 Kaggle 导出的完整 Python 代码，或导入 `.py` / `.ipynb` 文件。
2. 为文件使用英文字母、数字、连字符或下划线命名，例如 `voice-clone-baseline`。
3. 点击 **保存到项目**。后端会把文件写进当前仓库：
   - `notebooks/<name>.py`：原样保存的 Python 源码。
   - `notebooks/<name>.ipynb`：由代码生成的标准 Jupyter Notebook。
   - `notebooks/<name>.meta.json`：标题、运行配置和保存时间等元数据。
4. 点击 **生成静态预检报告**，会把检查结果写到 `experiments/`。预检报告不包含或执行用户代码。

Notebook 中的 `# %%` 分隔符会转换成独立单元；Jupytext 风格的 `# %% [markdown]` 也会生成 Markdown 单元。导入 `.ipynb` 时会保留单元顺序和 Markdown 文本，但不会保留输出、图像附件或 Kaggle 专属元数据。

## 重要限制

这是一个**本地保存与静态预检模拟器**，不是 Kaggle 云端运行时。预检只扫描代码文本中的 Notebook 单元、Kaggle 路径、GPU 线索、shell magic 和常见语音库名。它**不会执行 Python、安装依赖、下载数据、训练语音克隆模型、连接 Kaggle，也不会提供真实的 T4/P100/GPU**。真正的训练请在 Kaggle 或你已配置好的本机环境运行。

浏览器草稿仅用于意外刷新后的临时恢复；需要持久化到仓库时，必须点击 **保存到项目**。生成的文件位于项目目录，后续可通过常规 Git 操作提交和推送。

## 测试

```bash
python3 -m unittest discover -s tests -v
```
