"""cfd_mesh stage against real blockMesh/checkMesh; skips without OpenFOAM."""
import pytest

from dsh_cae import cfd_case

BASHRC = cfd_case.try_resolve_bashrc()
if BASHRC is None:
    pytest.skip("no OpenFOAM bashrc resolvable", allow_module_level=True)


def _mesh(stage, workdir, parse_receipt, name, **kw):
    argv = ["cfd_mesh", "--workdir", str(workdir), "--name", name,
            "--length-mm", kw.get("length", "100"),
            "--width-mm", kw.get("width", "20"),
            "--height-mm", kw.get("height", "10"),
            "--cell-size-mm", kw.get("cell", "5"),
            "--bashrc", BASHRC, "--timeout-s", "120"]
    if "grading" in kw:
        argv += ["--wall-grading", kw["grading"]]
    if "dict_file" in kw:
        argv += ["--block-mesh-dict-file", kw["dict_file"]]
    return parse_receipt(stage(workdir, *argv))


def test_mesh_generated_duct_receipt_is_pure_si(stage, workdir, parse_receipt):
    receipt = _mesh(stage, workdir, parse_receipt, "d1")
    assert receipt["caseDir"].endswith("/cfd/d1")
    assert receipt["blockMeshDictPath"].endswith("system/blockMeshDict")
    # mm→m happened exactly once at this boundary: 100×20×10 mm → 0.1×0.02×0.01 m
    assert receipt["boundsM"] == {"min": [0.0, 0.0, 0.0], "max": [0.1, 0.02, 0.01]}
    assert receipt["cells"] == 20 * 4 * 2
    assert receipt["checksPassed"] is True
    assert receipt["maxNonOrthogonalityDeg"] == 0.0
    assert receipt["logTail"]


def test_mesh_wall_grading_keeps_cell_count(stage, workdir, parse_receipt):
    plain = _mesh(stage, workdir, parse_receipt, "g1")
    graded = _mesh(stage, workdir, parse_receipt, "g2", grading="4")
    assert graded["cells"] == plain["cells"] == 160
    assert graded["checksPassed"] is True


def test_mesh_escape_hatch_dict_replaces_generated_one(stage, workdir, parse_receipt):
    dict_text = cfd_case.render_block_mesh_dict(0.05, 0.02, 0.01, 0.01, 1.0)
    dict_file = workdir / "custom.dict"
    dict_file.write_text(dict_text)
    receipt = _mesh(stage, workdir, parse_receipt, "esc", dict_file=str(dict_file))
    assert receipt["boundsM"]["max"] == [0.05, 0.02, 0.01]
    assert receipt["cells"] == 5 * 2 * 1


def test_mesh_rejects_nonpositive_dimensions(stage, workdir):
    proc = stage(workdir, "cfd_mesh", "--workdir", str(workdir), "--name", "neg",
                 "--length-mm", "-5", "--width-mm", "20", "--height-mm", "10",
                 "--cell-size-mm", "5", "--bashrc", BASHRC, "--timeout-s", "120")
    assert proc.returncode != 0
    assert "--length-mm must be positive, got -5.0" in proc.stderr + proc.stdout


def test_mesh_bad_escape_dict_fails_loud(stage, workdir):
    bad = workdir / "bad.dict"
    bad.write_text("this is not a foam dict")
    proc = stage(workdir, "cfd_mesh", "--workdir", str(workdir), "--name", "bad",
                 "--length-mm", "100", "--width-mm", "20", "--height-mm", "10",
                 "--cell-size-mm", "5", "--block-mesh-dict-file", str(bad),
                 "--bashrc", BASHRC, "--timeout-s", "120")
    assert proc.returncode != 0
    assert "blockMesh failed" in proc.stderr
