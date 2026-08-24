import json
import os
import pathlib
import subprocess
import sys

import pytest

REPO = pathlib.Path(__file__).resolve().parents[1]
PYTHON_DIR = REPO / "python"
sys.path.insert(0, str(PYTHON_DIR))


@pytest.fixture()
def workdir(tmp_path):
    return tmp_path


def run_stage(workdir, stage: str, *args: str):
    env = dict(os.environ, PYTHONPATH=str(PYTHON_DIR))
    return subprocess.run(
        [sys.executable, "-m", f"dsh_cae.{stage}", *args],
        cwd=workdir, env=env, capture_output=True, text=True, timeout=120,
    )


@pytest.fixture()
def parse_receipt():
    def _parse(proc) -> dict:
        mark = "<<<DSH_CAE_JSON>>>"
        assert mark in proc.stdout, f"no receipt in stdout:\n{proc.stdout}\n{proc.stderr}"
        return json.loads(proc.stdout.split(mark, 1)[1].strip())
    return _parse


@pytest.fixture()
def stage():
    return run_stage
