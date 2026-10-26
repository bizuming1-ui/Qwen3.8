"""Small persistent Python kernel used by the local Kaggle workbench.

Protocol: one JSON request per stdin line, JSON events per stdout line.
Only Python's standard library is required.
"""

from __future__ import annotations

import ast
import io
import json
import os
from pathlib import Path
import subprocess
import sys
import time
import traceback

CONTROL_STDOUT = sys.stdout
WORKING_DIRECTORY = str(Path(os.environ["KAGGLE_WORKING_DIR"]).resolve())
INPUT_DIRECTORY = str(Path(os.environ["KAGGLE_INPUT_DIR"]).resolve())
CURRENT_JOB_ID = ""


def send(event: dict) -> None:
    CONTROL_STDOUT.write(json.dumps(event, ensure_ascii=False) + "\n")
    CONTROL_STDOUT.flush()


class EventStream(io.TextIOBase):
    def __init__(self, name: str) -> None:
        self.name = name

    def write(self, text: str) -> int:
        if text:
            send(
                {
                    "type": "stream",
                    "jobId": CURRENT_JOB_ID,
                    "name": self.name,
                    "text": str(text),
                }
            )
        return len(text)

    def flush(self) -> None:
        return None


class KagglePathTransformer(ast.NodeTransformer):
    """Map the two familiar absolute Kaggle paths into this repository."""

    def visit_Constant(self, node: ast.Constant):
        if isinstance(node.value, str):
            if node.value == "/kaggle/working" or node.value.startswith("/kaggle/working/"):
                suffix = node.value[len("/kaggle/working") :].lstrip("/")
                node.value = os.path.join(WORKING_DIRECTORY, suffix) if suffix else WORKING_DIRECTORY
            elif node.value == "/kaggle/input" or node.value.startswith("/kaggle/input/"):
                suffix = node.value[len("/kaggle/input") :].lstrip("/")
                node.value = os.path.join(INPUT_DIRECTORY, suffix) if suffix else INPUT_DIRECTORY
        return node


def map_kaggle_paths(value: str) -> str:
    return value.replace("/kaggle/working", WORKING_DIRECTORY).replace("/kaggle/input", INPUT_DIRECTORY)


def run_shell(command: str) -> None:
    command = map_kaggle_paths(command)
    process = subprocess.Popen(
        command,
        shell=True,
        cwd=os.getcwd(),
        env=os.environ.copy(),
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        bufsize=1,
    )
    assert process.stdout is not None
    for line in process.stdout:
        print(line, end="")
    return_code = process.wait()
    if return_code:
        print(f"Shell command exited with status {return_code}.", file=sys.stderr)


def change_directory(directory: str) -> None:
    os.chdir(map_kaggle_paths(directory))


def display(value) -> None:
    send(
        {
            "type": "result",
            "jobId": CURRENT_JOB_ID,
            "text": repr(value)[:100_000],
        }
    )


def unsupported_input(_prompt=""):
    raise RuntimeError("Interactive input() is not supported by this workbench kernel.")


def preprocess_magics(source: str) -> str:
    """Support the Kaggle shell/pip/cd forms most often used in setup cells."""
    transformed = []
    for line in source.splitlines(keepends=True):
        ending = "\n" if line.endswith("\n") else ""
        body = line[:-1] if ending else line
        stripped = body.lstrip()
        indent = body[: len(body) - len(stripped)]
        if stripped.startswith("!"):
            command = stripped[1:]
            body = f"{indent}__kaggle_shell__({command!r})"
        elif stripped.startswith("%pip "):
            command = f'"{sys.executable}" -m pip ' + stripped[len("%pip ") :]
            body = f"{indent}__kaggle_shell__({command!r})"
        elif stripped.startswith("%cd "):
            directory = stripped[len("%cd ") :].strip().strip("\"'")
            body = f"{indent}__kaggle_chdir__({directory!r})"
        transformed.append(body + ending)
    return "".join(transformed)


GLOBALS = {
    "__name__": "__main__",
    "__kaggle_shell__": run_shell,
    "__kaggle_chdir__": change_directory,
    "display": display,
    "input": unsupported_input,
}


def execute(source: str, job_id: str) -> None:
    global CURRENT_JOB_ID
    CURRENT_JOB_ID = job_id
    started = time.perf_counter()
    sys.stdout = EventStream("stdout")
    sys.stderr = EventStream("stderr")

    try:
        tree = ast.parse(preprocess_magics(source), filename=f"<cell-{job_id[:8]}>", mode="exec")
        tree = KagglePathTransformer().visit(tree)
        ast.fix_missing_locations(tree)

        last_expression = None
        if tree.body and isinstance(tree.body[-1], ast.Expr):
            last_expression = ast.Expression(tree.body[-1].value)
            tree.body = tree.body[:-1]

        if tree.body:
            exec(compile(tree, filename=f"<cell-{job_id[:8]}>", mode="exec"), GLOBALS)
        if last_expression is not None:
            value = eval(compile(last_expression, filename=f"<cell-{job_id[:8]}>", mode="eval"), GLOBALS)
            if value is not None:
                display(value)

        send(
            {
                "type": "done",
                "jobId": job_id,
                "status": "success",
                "durationMs": round((time.perf_counter() - started) * 1000),
            }
        )
    except BaseException:
        formatted = traceback.format_exc()
        send(
            {
                "type": "error",
                "jobId": job_id,
                "text": formatted,
            }
        )
        send(
            {
                "type": "done",
                "jobId": job_id,
                "status": "error",
                "durationMs": round((time.perf_counter() - started) * 1000),
            }
        )
    finally:
        sys.stdout = CONTROL_STDOUT
        sys.stderr = sys.__stderr__
        CURRENT_JOB_ID = ""


def main() -> None:
    os.makedirs(WORKING_DIRECTORY, exist_ok=True)
    os.makedirs(INPUT_DIRECTORY, exist_ok=True)
    os.chdir(WORKING_DIRECTORY)
    os.environ["KAGGLE_KERNEL_RUN_TYPE"] = "Interactive"
    send(
        {
            "type": "ready",
            "python": sys.version.split()[0],
            "executable": sys.executable,
            "cwd": os.getcwd(),
        }
    )

    for line in sys.stdin:
        try:
            request = json.loads(line)
            if request.get("type") == "execute":
                execute(str(request.get("code", "")), str(request["jobId"]))
            elif request.get("type") == "shutdown":
                break
        except BaseException:
            send({"type": "kernel_error", "text": traceback.format_exc()})


if __name__ == "__main__":
    main()
