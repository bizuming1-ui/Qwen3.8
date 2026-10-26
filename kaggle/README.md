# kaggle/ — 真实 Kaggle 代码存放处

这里放的是**你正在 Kaggle 上运行的真实 notebook 文件**（原始文件，不做任何改写）。

模拟器（`src/kaggle-code.js`）由它生成：

```bash
npm run import:kaggle -- kaggle/your_notebook.ipynb
# 或者
node scripts/import-kaggle.mjs ./你的文件.ipynb
```

支持三种输入：

| 文件 | 解析方式 |
|---|---|
| `.ipynb` | 读取 JSON 的 `cells`，code / markdown 分开 |
| `.py` | 按 `# %%` 或 `# In[ ]` 分节 |
| `.txt` / `.md` | 整段作为一个单元格（自动判断是代码还是说明） |

导入后：
1. 源文件被复制/p保留在 `kaggle/`（会进 Git）
2. 生成 `src/kaggle-code.js`，模拟器默认加载你的真实单元格
3. 页面里也能手动导入：Notebook 右上角 **⬆ Import .ipynb**

也可以反向导出：Notebook 右上角 **⤓ Export .ipynb**，把模拟器里改过的版本存回 `.ipynb`。
