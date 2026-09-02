# pytest/test_mesh.py
import json

import pytest

pytest.importorskip("build123d")
pytest.importorskip("gmsh")

from test_cad import CANTILEVER  # noqa: F401 - reuse the model script

TWO_DISJOINT_BOXES = """
from build123d import Box
part = Box(30, 30, 30) + Box(30, 30, 30).translate((100, 0, 0))
"""


def _build(workdir, stage):
    script = workdir / "beam.cad.py"
    script.write_text(CANTILEVER)
    step = workdir / "beam.step"
    faces = workdir / "beam.faces.json"
    proc = stage(workdir, "cad", "--script-file", str(script), "--step", str(step), "--faces-json", str(faces))
    assert "<<<DSH_CAE_JSON>>>" in proc.stdout
    return step, faces


def test_mesh_creates_named_groups(stage, workdir, parse_receipt):
    step, faces = _build(workdir, stage)
    msh = workdir / "beam.msh"
    proc = stage(workdir, "mesh", "--step", str(step), "--faces-json", str(faces),
                 "--msh", str(msh), "--element-size", "4.0")
    receipt = parse_receipt(proc)
    assert msh.exists()
    assert set(receipt["groupNames"]) >= {"fixed", "load", "solid"}
    assert receipt["nodeCount"] > 100
    assert receipt["elementCount"] > 50
    assert receipt["quality"]["minJacobian"] is None or receipt["quality"]["minJacobian"] > 0.0
    assert receipt["connectivity"]["components"] == 1
    assert receipt["connectivity"]["isolatedElements"] == 0
    assert "warnings" not in receipt


def test_mesh_counts_disconnected_components(stage, workdir, parse_receipt):
    # A singular system (floating solids) must be flagged at mesh time, not
    # discovered as a solver that never converges.
    script = workdir / "twobox.cad.py"
    script.write_text(TWO_DISJOINT_BOXES)
    step = workdir / "twobox.step"
    proc = stage(workdir, "cad", "--script-file", str(script), "--step", str(step))
    assert "<<<DSH_CAE_JSON>>>" in proc.stdout
    msh = workdir / "twobox.msh"
    proc = stage(workdir, "mesh", "--step", str(step), "--msh", str(msh), "--element-size", "6.0")
    receipt = parse_receipt(proc)
    assert receipt["connectivity"]["components"] == 2
    assert receipt["connectivity"]["totalElements"] == receipt["elementCount"]
    assert receipt["connectivity"]["isolatedElements"] > 0
    assert any("disconnected" in w for w in receipt["warnings"])


def test_mesh_tolerates_absent_faces_sidecar(stage, workdir, parse_receipt):
    # The TS tool layer always passes --faces-json, but cad.py writes the
    # sidecar only when the script defined NAMED_FACES — geometry from a
    # first CAD pass (unnamed faces) must still mesh (regression: this
    # exact path failed CI's tools-cad-mesh real-kernel test).
    script = workdir / "plain.cad.py"
    script.write_text("from build123d import Box\npart = Box(100, 20, 5)\n")
    step = workdir / "plain.step"
    faces = workdir / "plain.faces.json"
    proc = stage(workdir, "cad", "--script-file", str(script),
                 "--step", str(step), "--faces-json", str(faces))
    assert "<<<DSH_CAE_JSON>>>" in proc.stdout
    assert not faces.exists()
    msh = workdir / "plain.msh"
    proc = stage(workdir, "mesh", "--step", str(step), "--faces-json", str(faces),
                 "--msh", str(msh), "--element-size", "4.0")
    receipt = parse_receipt(proc)
    assert msh.exists()
    assert receipt["groupNames"] == ["solid"]


def test_mesh_fails_loud_when_no_face_matches(stage, workdir):
    step, _ = _build(workdir, stage)
    bad = workdir / "bad.faces.json"
    bad.write_text(json.dumps({"ghost": {"centroidMm": [999, 999, 999], "areaMm2": 1.0, "normal": [0, 0, 1]}}))
    proc = stage(workdir, "mesh", "--step", str(step), "--faces-json", str(bad),
                 "--msh", str(workdir / "bad.msh"))
    assert proc.returncode == 1
    assert "ghost" in proc.stderr and "candidates" in proc.stderr
