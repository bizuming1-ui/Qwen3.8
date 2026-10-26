import json
import tempfile
import unittest
from pathlib import Path

import server


class NotebookStorageTests(unittest.TestCase):
    def test_saves_python_ipynb_and_metadata_into_project_directory(self):
        code = "# %% [markdown]\n# Voice cloning experiment\n# %%\nimport torch\nmodel = torch.nn.Linear(2, 1)\n"
        with tempfile.TemporaryDirectory() as temp_dir:
            directory = Path(temp_dir)
            result = server.save_notebook(
                {
                    "name": "voice-clone-baseline",
                    "title": "Voice clone baseline",
                    "code": code,
                    "runtime": "Kaggle T4（模拟）",
                },
                directory,
            )

            source_path = directory / "voice-clone-baseline.py"
            notebook_path = directory / "voice-clone-baseline.ipynb"
            metadata_path = directory / "voice-clone-baseline.meta.json"
            self.assertEqual(source_path.read_text(encoding="utf-8"), code)
            self.assertTrue(notebook_path.is_file())
            self.assertTrue(metadata_path.is_file())
            self.assertEqual(result["source_file"], "notebooks/voice-clone-baseline.py")

            notebook = json.loads(notebook_path.read_text(encoding="utf-8"))
            self.assertEqual(notebook["nbformat"], 4)
            self.assertEqual([cell["cell_type"] for cell in notebook["cells"]], ["markdown", "code"])
            self.assertTrue(all(len(cell["id"]) == 8 for cell in notebook["cells"]))
            self.assertEqual("".join(notebook["cells"][0]["source"]), "Voice cloning experiment\n")
            self.assertIn("import torch", "".join(notebook["cells"][1]["source"]))
            self.assertEqual(json.loads(metadata_path.read_text(encoding="utf-8"))["title"], "Voice clone baseline")

    def test_load_and_list_notebooks(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            directory = Path(temp_dir)
            server.save_notebook({"name": "exp-01", "code": "print('hello')\n"}, directory)

            loaded = server.load_notebook("exp-01", directory)
            notebooks = server.list_notebooks(directory)
            self.assertEqual(loaded["code"], "print('hello')\n")
            self.assertEqual(len(notebooks), 1)
            self.assertEqual(notebooks[0]["name"], "exp-01")
            self.assertEqual(notebooks[0]["notebook_file"], "notebooks/exp-01.ipynb")

    def test_rejects_empty_code_and_unsafe_names(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            directory = Path(temp_dir)
            with self.assertRaises(server.ApiError) as empty_error:
                server.save_notebook({"name": "experiment", "code": " \n"}, directory)
            self.assertEqual(empty_error.exception.status, 400)

            with self.assertRaises(server.ApiError) as path_error:
                server.save_notebook({"name": "../outside", "code": "print(1)"}, directory)
            self.assertEqual(path_error.exception.status, 400)
            self.assertEqual(list(directory.iterdir()), [])

    def test_parses_jupytext_code_and_markdown_cells(self):
        code = (
            "# %% [markdown]\n"
            "# Experiment notes\n"
            "# %%\n"
            "import numpy as np\n"
            "# %% [raw]\n"
            "unparsed content\n"
        )
        cells = server.parse_code_cells(code)
        self.assertEqual([cell["cell_type"] for cell in cells], ["markdown", "code", "raw"])
        self.assertEqual("".join(cells[0]["source"]), "Experiment notes\n")
        self.assertEqual("".join(cells[1]["source"]), "import numpy as np\n")
        self.assertEqual("".join(cells[2]["source"]), "unparsed content\n")


class ExperimentStorageTests(unittest.TestCase):
    def test_writes_static_preflight_record_without_code(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            directory = Path(temp_dir)
            result = server.save_experiment(
                {
                    "notebook_name": "voice-clone-baseline",
                    "config": {"runtime": "kaggle-t4", "epochs": 30, "batch_size": 8, "sample_rate": 24000},
                    "code_stats": {"characters": 120, "lines": 6, "cells": 2},
                    "checks": [{"label": "Kaggle path", "detail": "No path found", "status": "ok"}],
                },
                directory,
            )
            files = list(directory.glob("*.json"))
            records = server.list_experiments(directory)
            self.assertEqual(len(files), 1)
            self.assertEqual(result["mode"], "static_preflight_simulation")
            self.assertEqual(result["status"], "simulated")
            self.assertNotIn("code", result)
            self.assertEqual(records[0]["notebook_name"], "voice-clone-baseline")
            self.assertEqual(records[0]["code_stats"]["cells"], 2)
            self.assertIn("No Python code", records[0]["note"])

    def test_rejects_unsafe_notebook_reference(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            with self.assertRaises(server.ApiError):
                server.save_experiment({"notebook_name": "../../secrets"}, Path(temp_dir))
            self.assertEqual(list(Path(temp_dir).iterdir()), [])


if __name__ == "__main__":
    unittest.main()
