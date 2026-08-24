import shutil
import subprocess

import pytest

pytest.importorskip("gmsh")
if shutil.which("ccx") is None:
    pytest.skip("CalculiX ccx not on PATH", allow_module_level=True)

from test_cad import CANTILEVER
from test_mesh import _build


def test_solve_cantilever_runs_and_converts(stage, workdir, parse_receipt):
    step, faces = _build(workdir, stage)
    msh = workdir / "beam.msh"
    proc = stage(workdir, "mesh", "--step", str(step), "--faces-json", str(faces),
                 "--msh", str(msh), "--element-size", "4.0")
    assert "<<<DSH_CAE_JSON>>>" in proc.stdout

    proc = stage(workdir, "solve", "--msh", str(msh), "--case", "case",
                 "--young-mpa", "210000", "--poisson", "0.3",
                 "--fixed-group", "fixed", "--load-group", "load", "--load-n", "0,-100,0")
    receipt = parse_receipt(proc)
    assert proc.returncode == 0
    assert receipt["exitCode"] == 0
    assert (workdir / "case.inp").exists()
    assert (workdir / "case.frd").exists()
    assert receipt["vtuPath"] is not None
    assert len(receipt["logTail"]) > 0


def test_solve_reports_domain_failure_without_throwing(stage, workdir, parse_receipt):
    step, faces = _build(workdir, stage)
    msh = workdir / "beam.msh"
    stage(workdir, "mesh", "--step", str(step), "--faces-json", str(faces),
          "--msh", str(msh), "--element-size", "4.0")
    # a *CLOAD on a nonexistent node makes ccx fail while the stage stays a
    # domain outcome: stage exit 0, receipt carries ccx's non-zero exitCode.
    # (A genuinely unconstrained model does NOT trip ccx: the spooles solver
    # factors the singular system and exits 0, and an unknown *KEYWORD is only
    # a warning — neither can drive this test.)
    bad = workdir / "bad.patch.inp"
    bad.write_text("*CLOAD\n999999999,3,-100\n")
    proc = stage(workdir, "solve", "--msh", str(msh), "--case", "free",
                 "--young-mpa", "210000", "--poisson", "0.3",
                 "--fixed-group", "fixed", "--load-group", "load", "--load-n", "0,-100,0",
                 "--script-file", str(bad))
    receipt = parse_receipt(proc)
    assert proc.returncode == 0
    assert receipt["exitCode"] != 0
    assert "ERROR" in receipt["logTail"]
