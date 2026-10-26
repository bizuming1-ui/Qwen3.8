# Persistent Kaggle working directory

This directory is the real, Git-backed counterpart of `/kaggle/working` in the browser workbench.

- Keep Python scripts, notebooks, configuration, and small documentation files here.
- Use **Save** to write editor changes to this directory immediately.
- Use **Commit & push** to commit only this directory and push the current branch.
- `outputs/`, `checkpoints/`, `runs/`, `models/`, large model weights, datasets, and generated audio are ignored by Git by default. Change `.gitignore` deliberately if you need a different policy.

The execution kernel rewrites string literals beginning with `/kaggle/working` to this directory. The files on disk are never rewritten.
