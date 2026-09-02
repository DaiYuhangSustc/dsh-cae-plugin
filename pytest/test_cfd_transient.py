# pytest/test_cfd_transient.py
"""cfd_transient stage against real foamRun; skips without OpenFOAM."""
import pytest

from dsh_cae import cfd_case

BASHRC = cfd_case.try_resolve_bashrc()
if BASHRC is None:
    pytest.skip("no OpenFOAM bashrc resolvable", allow_module_level=True)


def _case(stage, workdir, parse_receipt, name):
    proc = stage(workdir, "cfd_mesh", "--workdir", str(workdir), "--name", name,
                 "--length-mm", "100", "--width-mm", "20", "--height-mm", "20",
                 "--cell-size-mm", "10", "--bashrc", BASHRC, "--timeout-s", "120")
    return parse_receipt(proc)["caseDir"]


def test_transient_marches_physical_time(stage, workdir, parse_receipt):
    case_dir = _case(stage, workdir, parse_receipt, "t1")
    proc = stage(workdir, "cfd_transient", "--case-dir", case_dir,
                 "--velocity", "0.02,0,0", "--nu", "1e-6", "--rho", "1000",
                 "--end-time-s", "0.05", "--write-interval-s", "0.05",
                 "--max-co", "0.5", "--bashrc", BASHRC, "--timeout-s", "300")
    receipt = parse_receipt(proc)
    assert proc.returncode == 0
    assert receipt["exitCode"] == 0
    assert receipt["timeStepsRun"] > 0
    assert receipt["simTimeS"] == pytest.approx(0.05, abs=1e-6)
    assert receipt["endTimeS"] == 0.05
    assert receipt["maxCourantSeen"] is not None and receipt["maxCourantSeen"] <= 0.6
    assert receipt["vtkPath"] and receipt["vtkPath"].endswith(".vtk")
    assert receipt["densityKgM3"] == 1000.0


def test_transient_fixed_delta_t(stage, workdir, parse_receipt):
    case_dir = _case(stage, workdir, parse_receipt, "t2")
    proc = stage(workdir, "cfd_transient", "--case-dir", case_dir,
                 "--velocity", "0.02,0,0", "--nu", "1e-6",
                 "--end-time-s", "0.02", "--write-interval-s", "0.02",
                 "--delta-t", "0.001", "--bashrc", BASHRC, "--timeout-s", "300")
    receipt = parse_receipt(proc)
    assert receipt["exitCode"] == 0
    assert receipt["timeStepsRun"] == 20  # 0.02 / 0.001, adjustableRunTime snaps exactly
    assert receipt["simTimeS"] == pytest.approx(0.02, abs=1e-9)


def test_transient_rejects_bad_args(stage, workdir):
    case_dir = str(workdir / "cfd" / "t3")
    for extra in (["--end-time-s", "0"], ["--end-time-s", "0.1", "--write-interval-s", "0.2"],
                  ["--end-time-s", "0.1", "--delta-t", "-1"]):
        proc = stage(workdir, "cfd_transient", "--case-dir", case_dir,
                     "--velocity", "0.02,0,0", "--nu", "1e-6", *extra)
        assert proc.returncode == 1, extra
