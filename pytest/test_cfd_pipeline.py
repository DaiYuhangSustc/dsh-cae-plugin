"""Acceptance pipeline: laminar square duct vs the Shah-London exact constant.

f·Re = 56.91 (Darcy) for a square section. Water (nu=1e-6, rho=1000) at U=0.02
m/s in a 20x20 mm duct gives Re=400 (laminar, entrance ~0.4 m). Theory: dP/dx =
f·(1/2)·rho·U^2 / Dh with f = 56.91/Re, i.e. 56.91 · mu·U / (2·Dh^2) =
56.91 * 1e-3 * 0.02 / (2 * 0.02^2) ≈ 1.42 Pa/m; developed centerline
Umax/Umean = 2.10 (square-duct tabulated value). The Darcy definition carries
the 1/2·rho·U^2 dynamic head; dropping the 1/2 doubles the constant.
"""
import json

import pytest

pytest.importorskip("pyvista")

from dsh_cae import cfd_case

BASHRC = cfd_case.try_resolve_bashrc()
if BASHRC is None:
    pytest.skip("no OpenFOAM bashrc resolvable", allow_module_level=True)

FRE_SQUARE = 56.91
U_MEAN = 0.02
NU = 1e-6
RHO = 1000.0
SIDE = 0.02  # m
DPDX_THEORY = FRE_SQUARE * (NU * RHO) * U_MEAN / (2 * SIDE ** 2)  # ≈ 1.42 Pa/m
UMAX_UMEAN_THEORY = 2.10


def test_shah_london_duct(stage, workdir, parse_receipt):
    meshed = parse_receipt(stage(workdir, "cfd_mesh",
                                 "--workdir", str(workdir), "--name", "accept",
                                 "--length-mm", "1000", "--width-mm", "20", "--height-mm", "20",
                                 "--cell-size-mm", "2.5", "--bashrc", BASHRC,
                                 "--timeout-s", "600"))
    assert meshed["cells"] == 400 * 8 * 8
    assert meshed["checksPassed"] is not False

    # conftest's run_stage caps every stage subprocess at 120 s, so converge on
    # a residualControl the Uy/Uz initial-residual plateau (~7e-4 on this mesh,
    # a smoothSolver floor that does not deepen with iterations or refinement)
    # can actually reach; the solution is converged and mesh-independent well
    # before the plateau, far tighter than the ±5% gate needs.
    overrides = workdir / "accept.overrides.json"
    overrides.write_text(json.dumps([
        {"file": "system/fvSolution", "entry": "SIMPLE",
         "dict": "SIMPLE { nNonOrthogonalCorrectors 0; consistent yes; "
                 "residualControl { p 1e-3; U 1e-3; } }"}]))
    solved = parse_receipt(stage(workdir, "cfd_steady",
                                 "--case-dir", meshed["caseDir"],
                                 "--velocity", "0.02,0,0", "--nu", "1e-6", "--rho", "1000",
                                 "--iterations", "1500", "--case", "run",
                                 "--overrides-file", str(overrides),
                                 "--bashrc", BASHRC, "--timeout-s", "1800"))
    assert solved["exitCode"] == 0
    assert solved["converged"] is True
    assert solved["vtkPath"]

    # x=0.5 and x=0.9 m sit past the ~0.4 m entrance; ny=nz=8 (even) puts mesh
    # vertices on the centerline y=z=0.01.
    post = parse_receipt(stage(workdir, "post", "--vtu", solved["vtkPath"],
                               "--png-stem", "duct", "--density-kg-m3", "1000",
                               "--probe", "pressure,0.5,0.01,0.01",
                               "--probe", "pressure,0.9,0.01,0.01",
                               "--probe", "velocity,0.9,0.01,0.01"))
    pressure_probes = sorted(
        (v for v in post["values"] if v["kind"] == "probe" and v["field"] == "pressure"),
        key=lambda v: v["atM"][0])
    assert len(pressure_probes) == 2, post["values"]
    (x05, p05), (x09, p09) = ((v["atM"][0], v["value"]) for v in pressure_probes)
    dpdx = (p05 - p09) / (x09 - x05)
    assert abs(dpdx - DPDX_THEORY) / DPDX_THEORY <= 0.05, (dpdx, DPDX_THEORY)

    umax = next(v["value"] for v in post["values"]
                if v["kind"] == "probe" and v["field"] == "velocity")
    assert abs(umax / U_MEAN - UMAX_UMEAN_THEORY) / UMAX_UMEAN_THEORY <= 0.10, umax / U_MEAN
