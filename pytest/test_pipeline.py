import shutil

import pytest

pytest.importorskip("build123d")
pytest.importorskip("gmsh")
pytest.importorskip("pyvista")
if shutil.which("ccx") is None:
    pytest.skip("CalculiX ccx not on PATH", allow_module_level=True)

from test_cad import CANTILEVER

# Geometry pins: must match the CANTILEVER script's Box(100, 20, 5) in test_cad.py.
L, W, H = 100.0, 20.0, 5.0
P = 100.0
E, NU = 210_000.0, 0.3
I = W * H ** 3 / 12.0
DELTA_THEORY = P * L ** 3 / (3.0 * E * I)


def test_cantilever_tip_deflection_matches_theory(stage, workdir, parse_receipt):
    script = workdir / "beam.cad.py"
    script.write_text(CANTILEVER)
    step, faces = workdir / "beam.step", workdir / "beam.faces.json"
    stage(workdir, "cad", "--script-file", str(script), "--step", str(step), "--faces-json", str(faces))
    msh = workdir / "beam.msh"
    stage(workdir, "mesh", "--step", str(step), "--faces-json", str(faces),
          "--msh", str(msh), "--element-size", "3.0")
    proc = stage(workdir, "solve", "--msh", str(msh), "--case", "case",
                 "--young-mpa", str(E), "--poisson", str(NU),
                 "--fixed-group", "fixed", "--load-group", "load", "--load-n", "0,0,-100")
    receipt = parse_receipt(proc)
    assert receipt["exitCode"] == 0
    proc = stage(workdir, "post", "--vtu", "case.vtu", "--png-stem", "case",
                 "--max", "displacement", "--max", "vonMises", "--plot", "vonMises")
    receipt = parse_receipt(proc)
    delta = next(v["value"] for v in receipt["values"] if v["field"] == "displacement")
    assert delta == pytest.approx(DELTA_THEORY, rel=0.05), (
        f"tip deflection {delta} vs theory {DELTA_THEORY}")
    von_mises = next(v["value"] for v in receipt["values"] if v["field"] == "vonMises")
    assert von_mises > 0
    plot = next(p for p in receipt["plots"] if p["field"] == "vonMises")
    assert plot["path"], f"plot failed: {plot.get('error')}"
