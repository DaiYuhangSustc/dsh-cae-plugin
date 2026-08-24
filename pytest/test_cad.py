import json

import pytest

pytest.importorskip("build123d")

CANTILEVER = """
from build123d import Box, Axis
part = Box(100, 20, 5)
NAMED_FACES = {
    "fixed": part.faces().filter_by(lambda f: abs(f.center().X + 50) < 1e-6)[0],
    "load": part.faces().filter_by(lambda f: abs(f.center().X - 50) < 1e-6)[0],
}
"""


def test_cad_build_exports_step_and_fingerprints(stage, parse_receipt, workdir):
    script = workdir / "beam.cad.py"
    script.write_text(CANTILEVER)
    step = workdir / "beam.step"
    faces = workdir / "beam.faces.json"
    proc = stage(workdir, "cad", "--script-file", str(script), "--step", str(step), "--faces-json", str(faces))
    receipt = parse_receipt(proc)
    assert step.exists()
    assert abs(receipt["volumeMm3"] - 100 * 20 * 5) < 1e-6
    assert receipt["bboxMm"]["min"] == [-50.0, -10.0, -2.5]
    assert receipt["bboxMm"]["max"] == [50.0, 10.0, 2.5]
    names = {f["name"] for f in receipt["namedFaces"]}
    assert names == {"fixed", "load"}
    sidecar = json.loads(faces.read_text())
    assert abs(sidecar["fixed"][0]["areaMm2"] - 20 * 5) < 1e-6


def test_cad_build_rejects_script_without_part(stage, workdir):
    script = workdir / "bad.cad.py"
    script.write_text("x = 1")
    proc = stage(workdir, "cad", "--script-file", str(script), "--step", str(workdir / "bad.step"))
    assert proc.returncode == 1
    assert "must define 'part'" in proc.stderr
