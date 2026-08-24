"""deps stage: group routing for the structural and cfd dependency sets."""
import subprocess


def _run(workdir, *args):
    import os
    import pathlib
    import sys
    env = dict(os.environ, PYTHONPATH=str(pathlib.Path(__file__).resolve().parents[1] / "python"))
    return subprocess.run([sys.executable, "-m", "dsh_cae.deps", *args],
                          cwd=workdir, env=env, capture_output=True, text=True, timeout=120)


def test_structural_group_shape(tmp_path, parse_receipt):
    receipt = parse_receipt(_run(tmp_path, "--group", "structural"))
    assert receipt["group"] == "structural"
    assert receipt["ok"] in (True, False)
    if receipt["ok"] is False:
        assert any("ccx" in m or "build123d" in m for m in receipt["missing"])


def test_cfd_group_shape(tmp_path, parse_receipt):
    receipt = parse_receipt(_run(tmp_path, "--group", "cfd"))
    assert receipt["group"] == "cfd"
    assert receipt["ok"] in (True, False)
    # Without an OpenFOAM environment the miss names the bashrc, not a crash.
    if receipt["ok"] is False:
        assert any("OpenFOAM" in m for m in receipt["missing"])


def test_default_group_is_structural(tmp_path, parse_receipt):
    receipt = parse_receipt(_run(tmp_path))
    assert receipt["group"] == "structural"
