"""cfd_steady stage against real foamRun; skips without OpenFOAM."""
import json
import pathlib

import pytest

from dsh_cae import cfd_case

BASHRC = cfd_case.try_resolve_bashrc()
if BASHRC is None:
    pytest.skip("no OpenFOAM bashrc resolvable", allow_module_level=True)


def _case(stage, workdir, parse_receipt, name, cell="10"):
    proc = stage(workdir, "cfd_mesh", "--workdir", str(workdir), "--name", name,
                 "--length-mm", "200", "--width-mm", "20", "--height-mm", "20",
                 "--cell-size-mm", cell, "--bashrc", BASHRC, "--timeout-s", "120")
    return parse_receipt(proc)["caseDir"]


def _solve(stage, workdir, case_dir, *extra):
    return stage(workdir, "cfd_steady", "--case-dir", case_dir,
                 "--velocity", "0.02,0,0", "--nu", "1e-6", "--rho", "1000",
                 "--bashrc", BASHRC, "--timeout-s", "300", *extra)


LOOSE_SIMPLE = ("SIMPLE { nNonOrthogonalCorrectors 0; consistent yes; "
                "residualControl { p 1e-2; U 1e-2; } }")


def test_steady_converges_and_writes_vtk(stage, workdir, parse_receipt):
    case_dir = _case(stage, workdir, parse_receipt, "s1")
    ov = workdir / "ov.json"
    ov.write_text(json.dumps([
        {"file": "system/fvSolution", "entry": "SIMPLE", "dict": LOOSE_SIMPLE}]))
    proc = _solve(stage, workdir, case_dir, "--overrides-file", str(ov),
                  "--iterations", "300", "--case", "run")
    receipt = parse_receipt(proc)
    assert proc.returncode == 0
    assert receipt["exitCode"] == 0
    assert receipt["converged"] is True
    assert 0 < receipt["iterationsRun"] <= 300
    assert receipt["vtkPath"] and receipt["vtkPath"].endswith(".vtk")
    assert receipt["finalResiduals"]["p"] is not None
    assert receipt["wallMs"] > 0
    assert receipt["densityKgM3"] == 1000.0  # echoed for cae_post_process's Pa conversion
    assert pathlib.Path(receipt["logPath"]).is_file()


def test_steady_overrides_rewrite_control_dict_endtime(stage, workdir, parse_receipt):
    case_dir = _case(stage, workdir, parse_receipt, "s2")
    ov = workdir / "ov.json"
    ov.write_text(json.dumps([
        {"file": "system/controlDict", "entry": "endTime", "dict": "endTime         5;"}]))
    proc = _solve(stage, workdir, case_dir, "--overrides-file", str(ov), "--case", "short")
    receipt = parse_receipt(proc)
    # --iterations wrote 300; the override then pinned endTime to 5
    assert receipt["iterationsRun"] == 5
    assert "endTime         5;" in (pathlib.Path(case_dir) / "system" / "controlDict").read_text()
    assert receipt["logPath"].endswith("short.foam.log")


def test_steady_rejects_out_of_whitelist_override(stage, workdir, parse_receipt):
    case_dir = _case(stage, workdir, parse_receipt, "s3")
    ov = workdir / "evil.json"
    ov.write_text(json.dumps([{"file": "../evil", "entry": "x", "dict": "x 1;"}]))
    proc = _solve(stage, workdir, case_dir, "--overrides-file", str(ov))
    assert proc.returncode != 0
    assert "not an overridable case file" in proc.stderr


def test_steady_rejects_missing_entry_override(stage, workdir, parse_receipt):
    case_dir = _case(stage, workdir, parse_receipt, "s4")
    ov = workdir / "missing.json"
    ov.write_text(json.dumps([
        {"file": "system/controlDict", "entry": "noSuchEntry", "dict": "noSuchEntry 1;"}]))
    proc = _solve(stage, workdir, case_dir, "--overrides-file", str(ov))
    assert proc.returncode != 0
    assert "not found at top level" in proc.stderr


def test_steady_requires_cfd_mesh_case(stage, workdir):
    proc = _solve(stage, workdir, workdir / "nowhere")
    assert proc.returncode != 0
    assert "is not a cfd_mesh case" in proc.stderr


def test_steady_rerun_discards_stale_times(stage, workdir, parse_receipt):
    # A first, longer run leaves time 300 behind; a rerun must not let
    # foamToVTK -latestTime pick up that stale solution as the new result.
    case_dir = _case(stage, workdir, parse_receipt, "s6")
    first = parse_receipt(_solve(stage, workdir, case_dir, "--iterations", "300", "--case", "run"))
    # defaults may converge before 300; what matters is a leftover time well past 5
    assert first["iterationsRun"] > 5
    assert pathlib.Path(first["vtkPath"]).name == f"s6_{first['iterationsRun']}.vtk"
    ov = workdir / "short.json"
    ov.write_text(json.dumps([
        {"file": "system/controlDict", "entry": "endTime", "dict": "endTime         5;"},
        {"file": "system/controlDict", "entry": "writeInterval", "dict": "writeInterval   1;"}]))
    second = parse_receipt(_solve(stage, workdir, case_dir,
                                  "--overrides-file", str(ov), "--case", "run"))
    assert second["iterationsRun"] == 5
    assert pathlib.Path(second["vtkPath"]).name == "s6_5.vtk"


def test_steady_reports_domain_outcome_without_dying(stage, workdir, parse_receipt):
    # nu = 0 with fixedValue inlet drives a degenerate solve; whatever foamRun
    # does, the stage must answer with a receipt, not crash.
    case_dir = _case(stage, workdir, parse_receipt, "s5")
    proc = stage(workdir, "cfd_steady", "--case-dir", case_dir,
                 "--velocity", "0.02,0,0", "--nu", "0", "--iterations", "3",
                 "--case", "degenerate", "--bashrc", BASHRC, "--timeout-s", "300")
    receipt = parse_receipt(proc)
    assert "exitCode" in receipt and "logTail" in receipt
