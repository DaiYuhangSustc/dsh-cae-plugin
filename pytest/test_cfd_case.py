"""Pure-library tests for cfd_case: rendering, overrides, and log parsing."""
import pathlib
import subprocess

import pytest

from dsh_cae import cfd_case

CHECK_MESH_OK = """Mesh stats
    points:           525
    faces:            1136
    internal faces:   784
    cells:            320

Checking geometry...
    Overall domain bounding box (0 0 0) (0.2 0.02 0.02)
    Max aspect ratio = 2 OK.
    Mesh non-orthogonality Max: 0 average: 0

Mesh OK.

End
"""

CHECK_MESH_FAILED = CHECK_MESH_OK.replace("Mesh OK.", "    Failed 1 mesh checks.")

FOAM_LOG = """Create time
SIMPLE: Convergence criteria found

Time = 1s

smoothSolver:  Solving for Ux, Initial residual = 1, Final residual = 0.1, No Iterations 1
smoothSolver:  Solving for Uy, Initial residual = 1, Final residual = 0.2, No Iterations 1
GAMG:  Solving for p, Initial residual = 1, Final residual = 0.3, No Iterations 1
ExecutionTime = 0.1 s  ClockTime = 0 s

Time = 2s

smoothSolver:  Solving for Ux, Initial residual = 0.1, Final residual = 0.01, No Iterations 1
smoothSolver:  Solving for Uz, Initial residual = 0.2, Final residual = 0.02, No Iterations 1
GAMG:  Solving for p, Initial residual = 0.3, Final residual = 0.03, No Iterations 1
ExecutionTime = 0.2 s  ClockTime = 0 s

End
"""

CONVERGED_LOG = FOAM_LOG.replace("End", "SIMPLE solution converged in 2 iterations\n\nEnd")


def test_render_uniform_duct_uses_si_meters_and_integer_cells():
    text = cfd_case.render_block_mesh_dict(0.1, 0.02, 0.01, 0.005, 1.0)
    assert "convertToMeters 1;" in text
    assert "hex (0 1 2 3 4 5 6 7) (20 4 2) simpleGrading (1 1 1)" in text
    assert "(0.1 0.02 0)" in text  # vertices already in meters
    for patch in ("inlet", "outlet", "walls"):
        assert patch in text


def test_render_wall_grading_is_symmetric_multigrading():
    text = cfd_case.render_block_mesh_dict(0.1, 0.02, 0.01, 0.005, 4.0)
    assert "(20 4 2)" in text  # grading never changes cell counts
    assert "((0.5 0.5 2) (0.5 0.5 0.5))" in text


def test_render_rounds_cell_counts():
    text = cfd_case.render_block_mesh_dict(0.1, 0.019, 0.01, 0.005, 1.0)
    assert "(20 4 2)" in text


def test_apply_override_replaces_scalar_entry():
    text = "FoamFile\n{\n    object controlDict;\n}\n\nendTime 2000;\ndeltaT 1;\n"
    out = cfd_case.apply_override(text, "endTime", "endTime 5;")
    assert "endTime 5;" in out and "endTime 2000" not in out and "deltaT 1;" in out


def test_apply_override_replaces_block_entry():
    text = "FoamFile\n{\n    object fvSolution;\n}\n\nSIMPLE\n{\n    consistent yes;\n}\n"
    new = "SIMPLE { consistent no; }"
    out = cfd_case.apply_override(text, "SIMPLE", new)
    assert new in out and "consistent yes" not in out


def test_apply_override_ignores_nested_and_comment_occurrences():
    text = ("FoamFile\n{\n    object controlDict;\n}\n\n"
            "// endTime 999; legacy note\n"
            "functions\n{\n    endTime 999;\n}\nendTime 2000;\n")
    out = cfd_case.apply_override(text, "endTime", "endTime 5;")
    assert "endTime 5;" in out and "endTime 999;" in text and "999" in out  # nested copy stays


def test_apply_override_rejects_unknown_entry():
    with pytest.raises(SystemExit):
        cfd_case.apply_override("endTime 1;\n", "nope", "nope 1;")


def test_apply_override_requires_whole_word():
    text = "endTimeScale 3;\nendTime 2000;\n"
    out = cfd_case.apply_override(text, "endTime", "endTime 5;")
    assert "endTimeScale 3;" in out


def test_apply_overrides_routes_files_and_rejects_out_of_whitelist(tmp_path):
    case = tmp_path / "case"
    cfd_case.write_case_skeleton(case, cfd_case.render_block_mesh_dict(0.1, 0.02, 0.02, 0.01, 1.0))
    cfd_case.apply_overrides(case, [
        {"file": "system/controlDict", "entry": "endTime", "dict": "endTime 7;"},
        {"file": "system/fvSolution", "entry": "SIMPLE",
         "dict": "SIMPLE { nNonOrthogonalCorrectors 0; }"},
    ])
    assert "endTime 7;" in (case / "system" / "controlDict").read_text()
    assert "nNonOrthogonalCorrectors 0;" in (case / "system" / "fvSolution").read_text()
    with pytest.raises(SystemExit):
        cfd_case.apply_overrides(case, [{"file": "../evil", "entry": "x", "dict": "x 1;"}])


def test_parse_check_mesh_ok():
    m = cfd_case.parse_check_mesh(CHECK_MESH_OK)
    assert m["cells"] == 320
    assert m["boundsM"] == {"min": [0.0, 0.0, 0.0], "max": [0.2, 0.02, 0.02]}
    assert m["maxAspectRatio"] == 2.0
    assert m["maxNonOrthogonalityDeg"] == 0.0
    assert m["checksPassed"] is True


def test_parse_check_mesh_failed_and_drifted():
    assert cfd_case.parse_check_mesh(CHECK_MESH_FAILED)["checksPassed"] is False
    drifted = cfd_case.parse_check_mesh("something completely different")
    assert drifted["checksPassed"] is None
    assert drifted["cells"] is None


def test_parse_foam_log_counts_iterations_and_residuals():
    m = cfd_case.parse_foam_log(FOAM_LOG)
    assert m["iterationsRun"] == 2
    assert m["converged"] is False
    assert m["finalResiduals"]["p"] == pytest.approx(0.03)
    assert m["finalResiduals"]["U"] == pytest.approx(0.02)  # max(Ux .01, Uz .02); Uy only in step 1
    assert cfd_case.parse_foam_log(CONVERGED_LOG)["converged"] is True


def test_parse_foam_log_empty():
    m = cfd_case.parse_foam_log("")
    assert m == {"iterationsRun": 0, "converged": False, "finalResiduals": {"p": None, "U": None}}


def test_write_case_skeleton_layout(tmp_path):
    case = tmp_path / "duct"
    cfd_case.write_case_skeleton(case, "convertToMeters 1;\n")
    expected = [
        "0/U", "0/p", "constant/physicalProperties", "constant/momentumTransport",
        "system/controlDict", "system/fvSchemes", "system/fvSolution", "system/blockMeshDict",
    ]
    for rel in expected:
        assert (case / rel).is_file(), rel
    assert "solver          incompressibleFluid;" in (case / "system" / "controlDict").read_text()
    assert "simulationType  laminar;" in (case / "constant" / "momentumTransport").read_text()


def test_write_fields_and_control_dict(tmp_path):
    case = tmp_path / "duct"
    cfd_case.write_case_skeleton(case, "convertToMeters 1;\n")
    cfd_case.write_fields(case, [0.02, 0.0, 0.0], 1e-6)
    cfd_case.write_control_dict(case, 5)
    u = (case / "0" / "U").read_text()
    assert "value           uniform (0.02 0 0);" in u
    assert "type            noSlip;" in u
    assert "dimensions      [0 1 -1 0 0 0 0];" in u
    p = (case / "0" / "p").read_text()
    assert "dimensions      [0 2 -2 0 0 0 0];" in p  # kinematic pressure m²/s²
    pp = (case / "constant" / "physicalProperties").read_text()
    assert "nu              1e-06;" in pp
    cd = (case / "system" / "controlDict").read_text()
    assert "endTime         5;" in cd and "writeInterval   5;" in cd


def test_resolve_bashrc_prefers_configured_and_reports_failure(monkeypatch, tmp_path):
    bogus = tmp_path / "nope"
    monkeypatch.setenv("FOAM_BASHRC", str(bogus))
    monkeypatch.setattr(cfd_case, "_BASHRC_GLOBS", [])
    assert cfd_case.try_resolve_bashrc() is None
    with pytest.raises(SystemExit):
        cfd_case.resolve_bashrc(None)
    good = tmp_path / "bashrc"
    good.write_text(":")
    assert cfd_case.resolve_bashrc(str(good)) == str(good)


def test_try_resolve_bashrc_from_glob(monkeypatch, tmp_path):
    root = tmp_path / "openfoam13" / "etc"
    root.mkdir(parents=True)
    (root / "bashrc").write_text(":")
    monkeypatch.delenv("FOAM_BASHRC", raising=False)
    monkeypatch.setattr(cfd_case, "_BASHRC_GLOBS", [str(tmp_path / "openfoam*" / "etc" / "bashrc")])
    assert cfd_case.try_resolve_bashrc() == str(root / "bashrc")


def test_foam_run_sources_bashrc(monkeypatch, tmp_path):
    bashrc = tmp_path / "bashrc"
    bashrc.write_text("export PROBE_VAR=from-bashrc\n")
    proc = cfd_case.foam_run(str(bashrc), "printenv", ["PROBE_VAR"], 30)
    assert isinstance(proc, subprocess.CompletedProcess)
    assert proc.returncode == 0
    assert proc.stdout.strip() == "from-bashrc"


def test_find_latest_vtk(tmp_path):
    case = tmp_path / "duct"
    vtk = case / "VTK"
    vtk.mkdir(parents=True)
    (vtk / "duct_0.vtk").write_text("")
    (vtk / "duct_20.vtk").write_text("")
    (vtk / "duct_100.vtk").write_text("")
    (vtk / "other").mkdir()
    (vtk / "other" / "duct_300.vtk").write_text("")
    assert cfd_case.find_latest_vtk(case) == str(vtk / "duct_100.vtk")
    assert cfd_case.find_latest_vtk(tmp_path / "empty") is None


def test_tail40_caps_lines_and_bytes():
    text = "\n".join(f"line{i}" for i in range(100))
    out = cfd_case.tail40(text)
    assert out.splitlines()[0] == "line60"
    assert len(out) <= 8192


def test_parse_transient_log_counts_steps_time_and_courant():
    log = "\n".join([
        "Courant Number mean: 0.213448 max: 0.419715",
        "deltaT 0.000408591",
        "smoothSolver:  Solving for Ux, Initial residual = 0.001, Final residual = 1e-07, No Iterations 1",
        "Time = 0.00122654",
        "Courant Number mean: 0.213481 max: 0.419794",
        "Time = 0.00163513",
        "Courant Number mean: 0.220000 max: 0.500000",
        "Time = 0.00204",
    ])
    parsed = cfd_case.parse_transient_log(log)
    assert parsed["timeStepsRun"] == 3
    assert parsed["simTimeS"] == pytest.approx(0.00204)
    assert parsed["maxCourantSeen"] == pytest.approx(0.5)
    assert cfd_case.parse_transient_log("") == {"timeStepsRun": 0, "simTimeS": 0.0, "maxCourantSeen": None}


def test_write_control_dict_transient_adaptive_and_fixed(tmp_path):
    import pathlib
    d = pathlib.Path(tmp_path)
    cfd_case.write_control_dict_transient(d, 2.0, None, 0.5, 0.1)
    text = (d / "system" / "controlDict").read_text()
    assert "endTime         2;" in text
    assert "adjustTimeStep  yes;" in text
    assert "maxCo           0.5;" in text
    assert "maxDeltaT       0.1;" in text
    assert "writeControl    adjustableRunTime;" in text
    assert "writeInterval   0.1;" in text
    cfd_case.write_control_dict_transient(d, 2.0, 0.001, None, 0.1)
    text = (d / "system" / "controlDict").read_text()
    assert "adjustTimeStep  no;" in text
    assert "deltaT          0.001;" in text
    assert "maxCo" not in text
