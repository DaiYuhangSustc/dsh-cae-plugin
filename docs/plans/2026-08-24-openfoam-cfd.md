# dsh-cae v1.1 OpenFOAM CFD Extension Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a parallel CFD chain (cae_cfd_mesh → cae_cfd_steady → cae_post_process) for steady incompressible laminar internal flow over OpenFOAM, per the approved spec `docs/specs/2026-08-24-openfoam-cfd-design.md`.

**Architecture:** Two new Python stages (`cfd_mesh`, `cfd_steady`) plus a shared `cfd_case.py` template/parse library, driven by two new TS tools; both layers couple only through argv and the `<<<DSH_CAE_JSON>>>` receipt line, exactly like the structural chain. Geometry enters in mm and is converted to SI once at the `cfd_mesh` boundary; the CFD chain is then pure SI (m, m/s, Pa, Pa·s).

**Tech Stack:** OpenFOAM 13 (Foundation, at `/opt/openfoam13` on this machine), Python 3.11 stdlib only for the new stages (no new pip deps), TypeScript + schemastery + dsh-tools for the tool layer, pytest + vitest.

## Global Constraints

- Branch `v1.1-openfoam-cfd` cut from `master` before Task 1; every task commits to it with conventional prefixes (`feat:`, `test:`, `docs:`).
- Commit identity on this machine: `git commit ...` (git has no global user configured).
- TS layer owns orchestration only (schemas, subprocess, timeouts, receipts); all domain knowledge lives in `python/dsh_cae/`. The layers couple through argv and the stdout receipt line `<<<DSH_CAE_JSON>>>` — nothing else.
- Solver outcomes are data; only infrastructure failures (missing bashrc/binary, timeout, unparseable stage output) raise. `checksPassed: false` and `converged: false` are normal receipts.
- Units: `cae_cfd_mesh` takes mm and converts mm→m exactly once (`/ 1000.0`); everything after is SI. `cae_post_process` converts kinematic pressure to Pa by multiplying `densityKgM3` (default 1).
- No new pip dependencies. OpenFOAM is invoked as `bash -c 'source "$0" && exec "$@"' <bashrc> <utility> -case <caseDir>`.
- Python files: no comments on facts obvious from code; every module docstring states the contract; deliberate solver realities get an explanatory comment at the encoding site.
- Every file ends with exactly one trailing newline.
- pytest invocation from repo root MUST use the console script (the `pytest/` directory shadows the package under `python -m pytest`): `PYVISTA_OFF_SCREEN=true ~/miniconda3/envs/dsh-cae/bin/pytest pytest/<file> -v`.
- TS gate: `pnpm build && pnpm vitest run` (keyless, must pass on every task).
- CFD pytest files skip at module level when no OpenFOAM bashrc resolves; pure-library tests (Task 1) never skip.
- Spec deviations validated against real OpenFOAM 13 (amend the spec in Task 1, commit `docs:`):
  1. OF13 removed standalone `simpleFoam`; the solver is `foamRun` with `solver incompressibleFluid;` in controlDict.
  2. Case files are `constant/physicalProperties` (not transportProperties) and `constant/momentumTransport` with `simulationType laminar;` (not turbulenceProperties).
  3. `foamToVTK` writes legacy `.vtk` only (no vtu option) — steady receipt field is `vtkPath`, not `vtuPath`.
  4. Dict `FoamFile` headers must use the multi-line tutorial banner; the single-line form makes OF13 report a bogus `Cannot find file`.
  5. controlDict sets `writeInterval = endTime` so the final iteration is always written for `foamToVTK -latestTime`.
  6. `cae_cfd_steady` echoes `densityKgM3` in its receipt (the spec listed the parameter but not the receipt field; without the echo the argv would be dead).
  7. `cae_post_process` probe parameter is renamed `pointMm` → `point` and CFD locations return as `atM` (meters), because the post tool is shared by both chains.

---

### Task 1: Shared CFD case library (`cfd_case.py`)

**Files:**
- Create: `python/dsh_cae/cfd_case.py`
- Test: `pytest/test_cfd_case.py`
- Modify: `docs/specs/2026-08-24-openfoam-cfd-design.md` (append the 7 measured deviations above as a section `## 实测修正（2026-08-24，OpenFOAM 13 本机验证）`)

**Interfaces:**
- Consumes: `dsh_cae.receipt.emit/fail` (existing).
- Produces (used by Tasks 2–4 and the pytest suites):

```python
_BASHRC_GLOBS: list[str]                                       # ["/opt/openfoam*/etc/bashrc", "/usr/lib/openfoam/*/etc/bashrc"]
CASE_DICT_FILES: frozenset[str]                                # overridable case dict relative paths
def try_resolve_bashrc() -> str | None                         # None when nothing resolves
def resolve_bashrc(configured: str | None) -> str              # fail() when unresolvable; lists tried paths
def foam_run(bashrc: str, util: str, args: list[str], timeout_s: int) -> subprocess.CompletedProcess
def render_block_mesh_dict(length_m: float, width_m: float, height_m: float, cell_m: float, wall_grading: float) -> str
def write_case_skeleton(case_dir: pathlib.Path, block_mesh_dict: str) -> None
def write_fields(case_dir: pathlib.Path, velocity_m_s: list[float], nu_m2_s: float) -> None
def write_control_dict(case_dir: pathlib.Path, iterations: int) -> None
def apply_override(dict_text: str, entry: str, new_text: str) -> str
def apply_overrides(case_dir: pathlib.Path, overrides: list[dict]) -> None
def parse_check_mesh(text: str) -> dict                        # {cells, boundsM, maxNonOrthogonalityDeg, maxAspectRatio, checksPassed}
def parse_foam_log(text: str) -> dict                          # {iterationsRun, converged, finalResiduals: {p, U}}
def find_latest_vtk(case_dir: pathlib.Path) -> str | None
def tail40(text: str) -> str
```

- [ ] **Step 1: Amend the spec with the measured deviations**

Append to `docs/specs/2026-08-24-openfoam-cfd-design.md` (before the risk table or after it — end of file):

```markdown
## 实测修正（2026-08-24，OpenFOAM 13 本机验证）

规划期探测本机 /opt/openfoam13 得出以下修正，实施以此为准：

1. Foundation OpenFOAM 13 移除了独立 `simpleFoam` 二进制：求解器为 `foamRun`，
   由 controlDict 的 `solver incompressibleFluid;` 选定（链路等价 simpleFoam）。
2. 物性文件是 `constant/physicalProperties`（`viscosityModel constant; nu ...;`）与
   `constant/momentumTransport`（层流 `simulationType laminar;`）——不是旧教程的
   transportProperties/turbulenceProperties。
3. OF13 的 `foamToVTK` 只输出 legacy `.vtk`（无 vtu 选项）：steady 回执字段为 `vtkPath`。
4. dict 的 `FoamFile` 头必须用教程式多行 banner；单行压缩形式会让 OF13 误报
   "Cannot find file"。
5. controlDict 令 `writeInterval = endTime`，保证最终迭代被写出供
   `foamToVTK -latestTime` 转换。
6. `cae_cfd_steady` 在回执中回显 `densityKgM3`（提示模型把同值传给 post 做 Pa 换算）。
7. `cae_post_process` 探针参数更名 `pointMm`→`point`，CFD 场的位置键为 `atM`（米）。
```

- [ ] **Step 2: Write the failing tests**

Create `pytest/test_cfd_case.py`. These are pure-library tests — no OpenFOAM needed, never skip:

```python
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
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `cd ~/dsh-cae && ~/miniconda3/envs/dsh-cae/bin/pytest pytest/test_cfd_case.py -v`
Expected: collection error `ModuleNotFoundError: No module named 'dsh_cae.cfd_case'`

- [ ] **Step 4: Implement `cfd_case.py`**

Create `python/dsh_cae/cfd_case.py`:

```python
"""Shared OpenFOAM case assembly: bashrc resolution, foam_run, template rendering,
top-level dict overrides, and checkMesh/foamRun log parsing. All lengths are SI
meters; callers own the single mm→m conversion at the cae_cfd_mesh boundary."""
import glob
import os
import pathlib
import re
import subprocess

from dsh_cae.receipt import fail

_BASHRC_GLOBS = ["/opt/openfoam*/etc/bashrc", "/usr/lib/openfoam/*/etc/bashrc"]

#: Case dict files an override may touch (case-rooted, exact membership).
CASE_DICT_FILES = frozenset({
    "system/controlDict", "system/fvSchemes", "system/fvSolution",
    "system/blockMeshDict", "constant/physicalProperties", "constant/momentumTransport",
})


def try_resolve_bashrc() -> str | None:
    """Locate an OpenFOAM etc/bashrc: $FOAM_BASHRC first, then the known install globs."""
    env = os.environ.get("FOAM_BASHRC")
    candidates = ([env] if env else []) + [p for g in _BASHRC_GLOBS for p in sorted(glob.glob(g))]
    for path in candidates:
        if pathlib.Path(path).is_file():
            return path
    return None


def resolve_bashrc(configured: str | None) -> str:
    """Strict variant of try_resolve_bashrc: infra-fail (listing tried paths) when unset."""
    if configured:
        if pathlib.Path(configured).is_file():
            return configured
        fail(f"openfoamBashrc '{configured}' does not exist")
    env = os.environ.get("FOAM_BASHRC")
    candidates = ([env] if env else []) + [p for g in _BASHRC_GLOBS for p in sorted(glob.glob(g))]
    for path in candidates:
        if pathlib.Path(path).is_file():
            return path
    fail("cannot locate an OpenFOAM environment; install OpenFOAM (https://openfoam.org/download), "
         "set openfoamBashrc, or export FOAM_BASHRC; tried:\n  " + "\n  ".join(candidates))


def foam_run(bashrc: str, util: str, args: list[str], timeout_s: int) -> subprocess.CompletedProcess:
    """Run one OpenFOAM utility with its environment sourced; with -c, $0 is the
    bashrc and "$@" the utility invocation, so no argument is ever re-expanded."""
    script = 'source "$0" && exec "$@"'
    return subprocess.run(["bash", "-c", script, bashrc, util, *args],
                          capture_output=True, text=True, timeout=timeout_s)


def _foam_header(cls: str, obj: str, location: str) -> str:
    # Multi-line banner is mandatory: the single-line form makes OpenFOAM 13
    # fail the read with a bogus "Cannot find file".
    return (f'FoamFile\n{{\n    format ascii;\n    class {cls};\n'
            f'    location "{location}";\n    object {obj};\n}}\n')


def render_block_mesh_dict(length_m: float, width_m: float, height_m: float,
                           cell_m: float, wall_grading: float) -> str:
    """blockMeshDict for a rectangular duct: flow +x, inlet at x-min, patches
    inlet/outlet/walls. Cell counts are rounded per direction; wall_grading is
    the symmetric center-to-wall expansion ratio in y and z (1 = uniform)."""
    nx = max(1, round(length_m / cell_m))
    ny = max(1, round(width_m / cell_m))
    nz = max(1, round(height_m / cell_m))
    if abs(wall_grading - 1.0) < 1e-12:
        grading = "simpleGrading (1 1 1)"
    else:
        # Symmetric multi-grading: each half-width expands by sqrt(ratio) so the
        # overall center-to-wall cell-size ratio equals wall_grading.
        half = wall_grading ** 0.5
        wall = f"((0.5 0.5 {half:.6g}) (0.5 0.5 {1 / half:.6g}))"
        grading = f"simpleGrading (1 {wall} {wall})"
    return _foam_header("dictionary", "blockMeshDict", "system") + f"""
convertToMeters 1;

vertices
(
    (0 0 0) ({length_m:.6g} 0 0) ({length_m:.6g} {width_m:.6g} 0) (0 {width_m:.6g} 0)
    (0 0 {height_m:.6g}) ({length_m:.6g} 0 {height_m:.6g}) ({length_m:.6g} {width_m:.6g} {height_m:.6g}) (0 {width_m:.6g} {height_m:.6g})
);

blocks ( hex (0 1 2 3 4 5 6 7) ({nx} {ny} {nz}) {grading} );

boundary
(
    inlet
    {{
        type patch;
        faces ( (0 4 7 3) );
    }}
    outlet
    {{
        type patch;
        faces ( (1 2 6 5) );
    }}
    walls
    {{
        type wall;
        faces ( (0 1 5 4) (3 7 6 2) (0 3 2 1) (4 5 6 7) );
    }}
);
"""


FV_SCHEMES = _foam_header("dictionary", "fvSchemes", "system") + """
ddtSchemes
{
    default         steadyState;
}

gradSchemes
{
    default         Gauss linear;
}

divSchemes
{
    default         none;
    div(phi,U)      bounded Gauss linearUpwind grad(U);
    div((nuEff*dev2(T(grad(U))))) Gauss linear;
}

laplacianSchemes
{
    default         Gauss linear corrected;
}

interpolationSchemes
{
    default         linear;
}

snGradSchemes
{
    default         corrected;
}
"""

FV_SOLUTION = _foam_header("dictionary", "fvSolution", "system") + """
solvers
{
    p
    {
        solver          GAMG;
        tolerance       1e-06;
        relTol          0.1;
        smoother        GaussSeidel;
    }

    U
    {
        solver          smoothSolver;
        smoother        symGaussSeidel;
        tolerance       1e-05;
        relTol          0.1;
    }
}

SIMPLE
{
    nNonOrthogonalCorrectors 0;
    consistent      yes;

    residualControl
    {
        p               1e-4;
        U               1e-5;
    }
}

relaxationFactors
{
    equations
    {
        U               0.9;
        ".*"            0.9;
    }
}
"""

MOMENTUM_TRANSPORT = _foam_header("dictionary", "momentumTransport", "constant") + """
simulationType  laminar;
"""


def write_case_skeleton(case_dir: pathlib.Path, block_mesh_dict: str) -> None:
    """Lay the full case: system dicts + laminar transport + placeholder fields/nu."""
    for sub in ("0", "constant", "system"):
        (case_dir / sub).mkdir(parents=True, exist_ok=True)
    (case_dir / "system" / "blockMeshDict").write_text(block_mesh_dict)
    (case_dir / "system" / "fvSchemes").write_text(FV_SCHEMES)
    (case_dir / "system" / "fvSolution").write_text(FV_SOLUTION)
    (case_dir / "constant" / "momentumTransport").write_text(MOMENTUM_TRANSPORT)
    write_fields(case_dir, [0.0, 0.0, 0.0], 1e-6)
    write_control_dict(case_dir, 2000)


def write_fields(case_dir: pathlib.Path, velocity_m_s: list[float], nu_m2_s: float) -> None:
    """(Re)write 0/U, 0/p (kinematic), and constant/physicalProperties for one solve."""
    u, v, w = velocity_m_s
    vel = f"({u:.8g} {v:.8g} {w:.8g})"
    (case_dir / "0" / "U").write_text(_foam_header("volVectorField", "U", "0") + f"""
dimensions      [0 1 -1 0 0 0 0];

internalField   uniform {vel};

boundaryField
{{
    inlet
    {{
        type            fixedValue;
        value           uniform {vel};
    }}
    outlet
    {{
        type            zeroGradient;
    }}
    walls
    {{
        type            noSlip;
    }}
}}
""")
    (case_dir / "0" / "p").write_text(_foam_header("volScalarField", "p", "0") + """
dimensions      [0 2 -2 0 0 0 0];

internalField   uniform 0;

boundaryField
{
    inlet
    {
        type            zeroGradient;
    }
    outlet
    {
        type            fixedValue;
        value           uniform 0;
    }
    walls
    {
        type            zeroGradient;
    }
}
""")
    (case_dir / "constant" / "physicalProperties").write_text(
        _foam_header("dictionary", "physicalProperties", "constant")
        + f"\nviscosityModel  constant;\n\nnu              {nu_m2_s:.6g};\n")


def write_control_dict(case_dir: pathlib.Path, iterations: int) -> None:
    """(Re)write controlDict; writeInterval = endTime so the final iteration is written."""
    (case_dir / "system" / "controlDict").write_text(
        _foam_header("dictionary", "controlDict", "system")
        + f"""
solver          incompressibleFluid;

startFrom       startTime;
startTime       0;
stopAt          endTime;
endTime         {iterations};
deltaT          1;

writeControl    timeStep;
writeInterval   {iterations};

purgeWrite      0;
writeFormat     ascii;
writePrecision  6;
writeCompression off;
timeFormat      general;
timePrecision   6;
runTimeModifiable true;
""")


def _is_word_char(ch: str) -> bool:
    return ch.isalnum() or ch == "_"


def _in_key_position(text: str, i: int) -> bool:
    """True when the token at i starts a top-level entry: the previous
    non-whitespace character is an entry terminator or start-of-file. Value
    tokens (e.g. the `endTime` in `stopAt endTime;`) are preceded by a word
    character and must not match."""
    j = i - 1
    while j >= 0 and text[j] in " \t\r\n":
        j -= 1
    return j < 0 or text[j] in "{};"


def apply_override(dict_text: str, entry: str, new_text: str) -> str:
    """Replace one top-level entry (outside FoamFile and comments) with new_text.
    Exact whole-word key match in entry position only; a missing entry is an
    error, never a fuzzy match. An entry ends at its `;` (scalar) or at the
    closing `}` of its block (dictionary entries carry no trailing `;`)."""
    i, depth, n = 0, 0, len(dict_text)
    while i < n:
        ch = dict_text[i]
        if ch == "/" and dict_text.startswith("//", i):
            nl = dict_text.find("\n", i)
            i = n if nl < 0 else nl + 1
            continue
        if ch == "/" and dict_text.startswith("/*", i):
            end = dict_text.find("*/", i + 2)
            i = n if end < 0 else end + 2
            continue
        if ch == "{":
            depth += 1
            i += 1
            continue
        if ch == "}":
            depth -= 1
            i += 1
            continue
        if (depth == 0 and dict_text.startswith(entry, i) and _in_key_position(dict_text, i)
                and (i + len(entry) >= n or not _is_word_char(dict_text[i + len(entry)]))):
            k, braces, end = i + len(entry), 0, -1
            while k < n:
                if dict_text[k] == "{":
                    braces += 1
                elif dict_text[k] == "}":
                    braces -= 1
                    if braces == 0:
                        end = k
                        break
                elif dict_text[k] == ";" and braces == 0:
                    end = k
                    break
                k += 1
            if end < 0:
                fail(f"override entry '{entry}' is not terminated by ';' or a closed block")
            return dict_text[:i] + new_text + dict_text[end + 1:]
        i += 1
    fail(f"override entry '{entry}' not found at top level")


def apply_overrides(case_dir: pathlib.Path, overrides: list[dict]) -> None:
    """Apply [{file, entry, dict}] against a case: whitelist files, exact entries."""
    rewritten: dict[str, str] = {}
    for ov in overrides:
        rel = ov["file"]
        if rel not in CASE_DICT_FILES:
            fail(f"override file '{rel}' is not an overridable case file; "
                 f"allowed: {', '.join(sorted(CASE_DICT_FILES))}")
        path = case_dir / rel
        if not path.is_file():
            fail(f"override target '{rel}' does not exist in the case")
        text = rewritten.get(rel, path.read_text())
        rewritten[rel] = apply_override(text, ov["entry"], ov["dict"])
    for rel, text in rewritten.items():
        (case_dir / rel).write_text(text)


def _last_float(text: str, pattern: str) -> float | None:
    matches = re.findall(pattern, text)
    return float(matches[-1]) if matches else None


def parse_check_mesh(text: str) -> dict:
    """Extract mesh metrics from checkMesh output; None fields when the format drifted.
    checksPassed is None (not a guess) when neither the OK nor the Failed marker appears."""
    cells = re.search(r"^\s*cells:\s+(\d+)", text, re.M)
    bbox = re.search(r"Overall domain bounding box \(([^)]*)\)\s*\(([^)]*)\)", text)
    if "Mesh OK." in text:
        passed: bool | None = True
    elif re.search(r"Failed\s+\d+\s+mesh checks", text):
        passed = False
    else:
        passed = None
    return {
        "cells": int(cells.group(1)) if cells else None,
        "boundsM": ({"min": [float(v) for v in bbox.group(1).split()],
                     "max": [float(v) for v in bbox.group(2).split()]} if bbox else None),
        "maxNonOrthogonalityDeg": _last_float(text, r"non-orthogonality Max:\s*([0-9.eE+-]+)"),
        "maxAspectRatio": _last_float(text, r"Max aspect ratio = ([0-9.eE+-]+)"),
        "checksPassed": passed,
    }


def parse_foam_log(text: str) -> dict:
    """Iteration count, convergence marker, and last final residuals (U = max component)."""
    final_re = r", Final residual = ([0-9.eE+-]+),"
    u_finals = [v for v in (
        _last_float(text, rf"Solving for {c}, Initial residual = [0-9.eE+-]+{final_re}")
        for c in ("Ux", "Uy", "Uz")
    ) if v is not None]
    return {
        "iterationsRun": len(re.findall(r"^Time = ", text, re.M)),
        "converged": "solution converged" in text,
        "finalResiduals": {
            "p": _last_float(text, rf"Solving for p, Initial residual = [0-9.eE+-]+{final_re}"),
            "U": max(u_finals) if u_finals else None,
        },
    }


def find_latest_vtk(case_dir: pathlib.Path) -> str | None:
    """Latest internal-mesh VTK/<case>_<time>.vtk written by foamToVTK (patches live in subdirs)."""
    stem = case_dir.resolve().name
    best, best_t = None, -1.0
    for f in (case_dir / "VTK").glob(f"{stem}_*.vtk"):
        m = re.fullmatch(rf"{re.escape(stem)}_([0-9.eE+-]+)\.vtk", f.name)
        if m and float(m.group(1)) > best_t:
            best, best_t = str(f), float(m.group(1))
    return best


def tail40(text: str) -> str:
    """Last 40 lines capped at 8 KiB, matching the structural chain's log tails."""
    return "\n".join(text.strip().splitlines()[-40:])[-8192:]
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd ~/dsh-cae && ~/miniconda3/envs/dsh-cae/bin/pytest pytest/test_cfd_case.py -v`
Expected: all PASS (22 tests)

- [ ] **Step 6: Commit**

```bash
cd ~/dsh-cae && git checkout -b v1.1-openfoam-cfd
git add python/dsh_cae/cfd_case.py pytest/test_cfd_case.py docs/specs/2026-08-24-openfoam-cfd-design.md
git commit -m "feat: shared OpenFOAM case library (cfd_case) with OF13-measured corrections"
```

---

### Task 2: Dependency groups (`deps.py --group` + `ensureDeps(group)`)

**Files:**
- Modify: `python/dsh_cae/deps.py` (whole file)
- Modify: `src/runner.ts:113-143` (depsOk cache + ensureDeps)
- Test: `pytest/test_deps.py` (new), `tests/deps.test.ts`

**Interfaces:**
- Consumes: `cfd_case.try_resolve_bashrc` (Task 1).
- Produces: `deps` stage CLI `--group structural|cfd [--bashrc PATH]` with receipt `{ok: boolean, missing: string[], group: string}`; TS `ensureDeps(config, signal?, group?: 'structural' | 'cfd')` (default `'structural'` — all four structural tools keep their exact call sites).

- [ ] **Step 1: Write the failing Python tests**

Create `pytest/test_deps.py`:

```python
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
```

- [ ] **Step 2: Run to verify failure**

Run: `cd ~/dsh-cae && ~/miniconda3/envs/dsh-cae/bin/pytest pytest/test_deps.py -v`
Expected: FAIL — `receipt` has no `group` key (`KeyError: 'group'` inside parse_receipt's json load assertion)

- [ ] **Step 3: Implement `deps.py --group`**

Replace `python/dsh_cae/deps.py`:

```python
"""Dependency self-check stage: structural probes imports + ccx, cfd probes the
OpenFOAM environment (bashrc resolvable and blockMesh/checkMesh/foamRun/foamToVTK on PATH)."""
import argparse
import subprocess

from dsh_cae import cfd_case
from dsh_cae.receipt import emit

PY_DEPS = ["build123d", "gmsh", "pyvista", "ccx2paraview"]

#: Utilities the cfd chain drives; all are stable across Foundation and ESI releases.
FOAM_UTILS = ["blockMesh", "checkMesh", "foamRun", "foamToVTK"]


def check_structural() -> list[str]:
    missing: list[str] = []
    for mod in PY_DEPS:
        try:
            __import__(mod)
        except ImportError:
            missing.append(mod)
    import shutil
    if shutil.which("ccx") is None:
        missing.append("ccx (CalculiX binary)")
    return missing


def check_cfd(bashrc_arg: str | None) -> list[str]:
    import pathlib
    if bashrc_arg:
        if not pathlib.Path(bashrc_arg).is_file():
            return [f"openfoamBashrc '{bashrc_arg}' does not exist"]
        bashrc = bashrc_arg
    else:
        bashrc = cfd_case.try_resolve_bashrc()
    if bashrc is None:
        return ["OpenFOAM bashrc (set openfoamBashrc/FOAM_BASHRC or install under /opt/openfoam*)"]
    script = ('source "$0" && for u in blockMesh checkMesh foamRun foamToVTK; '
              'do command -v "$u" >/dev/null 2>&1 || exit 3; done')
    proc = subprocess.run(["bash", "-c", script, bashrc], capture_output=True, text=True, timeout=120)
    if proc.returncode != 0:
        return [f"OpenFOAM utilities ({', '.join(FOAM_UTILS)}) via {bashrc}"]
    return []


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--group", choices=["structural", "cfd"], default="structural")
    parser.add_argument("--bashrc")
    args = parser.parse_args()
    missing = check_structural() if args.group == "structural" else check_cfd(args.bashrc)
    emit({"ok": not missing, "missing": missing, "group": args.group})


if __name__ == "__main__":
    main()
```

- [ ] **Step 4: Run Python tests, then update TS runner**

Run: `cd ~/dsh-cae && ~/miniconda3/envs/dsh-cae/bin/pytest pytest/test_deps.py -v`
Expected: 3 PASS

In `src/runner.ts`, replace the cached-verdict block and `ensureDeps` (lines 113–143) with:

```typescript
/** Dependency group a tool chain needs before its stages may run. */
export type DepsGroup = 'structural' | 'cfd'

/** Cached verdicts of the interpreter dependency self-check, per group. */
const depsOk = new WeakMap<Config, Set<DepsGroup>>()

const STRUCTURAL_HINT =
  'Install with:\n  pip install build123d gmsh pyvista ccx2paraview\n'
  + '  conda install -c conda-forge calculix  # or: sudo apt install calculix-ccx'
const CFD_HINT =
  'Install OpenFOAM (https://openfoam.org/download), or point openfoamBashrc/FOAM_BASHRC '
  + 'at an existing etc/bashrc (auto-checked: /opt/openfoam*/etc/bashrc, /usr/lib/openfoam/*/etc/bashrc).'

/**
 * Verify once per config object and group that the stage dependencies are
 * present; throws with the exact install hint on the first missing set.
 * @param config - deployment configuration.
 * @param signal - abort signal forwarded to the check subprocess.
 * @param group - dependency set: 'structural' (default) or 'cfd'.
 */
export async function ensureDeps(
  config: Config, signal?: AbortSignal, group: DepsGroup = 'structural',
): Promise<void> {
  const seen = depsOk.get(config) ?? new Set<DepsGroup>()
  depsOk.set(config, seen)
  if (seen.has(group)) return
  const argv = ['--group', group]
  if (group === 'cfd' && config.openfoamBashrc) argv.push('--bashrc', config.openfoamBashrc)
  const { receipt } = await runStage(config, 'deps', argv, {
    signal, logFile: `deps.${group}.log`,
  }).catch((error: Error) => {
    throw new Error(
      `dsh-cae cannot start its Python stages with interpreter '${config.python}': `
      + `${error.message}\n${group === 'cfd' ? CFD_HINT : STRUCTURAL_HINT}`,
    )
  })
  if (receipt.ok !== true) {
    throw new Error(
      `dsh-cae ${group} dependencies are incomplete (missing: ${JSON.stringify(receipt.missing ?? [])}).\n`
      + (group === 'cfd' ? CFD_HINT : STRUCTURAL_HINT),
    )
  }
  seen.add(group)
}
```

Note: this step also requires `Config.openfoamBashrc` to exist — add it to `src/config.ts` now (the cfd tools in Task 6 consume it):

```typescript
export interface Config {
  /** Interpreter that has build123d, gmsh, pyvista, meshio importable (CalculiX `ccx` on PATH). */
  python: string
  /** Directory (relative to the agent cwd) holding all CAE artifacts. */
  workdir: string
  /** Per-stage wall-clock budget in ms; exceeded kills the stage process group. */
  stageTimeoutMs: number
  /** Absolute path to an OpenFOAM etc/bashrc; omit to auto-detect ($FOAM_BASHRC, /opt/openfoam*, /usr/lib/openfoam*). */
  openfoamBashrc?: string | undefined
}

export const Config: z<Config> = z.object({
  python: z.string().default('python3').description('Interpreter with build123d/gmsh/pyvista/meshio installed'),
  workdir: z.string().default('./cae').description('Artifact directory for STEP/MSH/INP/FRD/VTU/PNG and CFD case files'),
  stageTimeoutMs: z.number().default(600000).description('Per-stage timeout in milliseconds'),
  openfoamBashrc: z.string().description('OpenFOAM etc/bashrc path; omit to auto-detect ($FOAM_BASHRC, /opt/openfoam*, /usr/lib/openfoam*)'),
})
```

- [ ] **Step 5: Extend the TS deps test**

In `tests/deps.test.ts`, add inside the existing describe:

```typescript
  it('routes the cfd group through the stage and reports its group', async () => {
    const config: Config = { python: 'python3', workdir: './cae-tmp', stageTimeoutMs: 60_000 }
    const { receipt } = await runStage(config, 'deps', ['--group', 'cfd'], { logFile: 'deps-cfd.log' })
    expect(receipt.group).toBe('cfd')
    expect(typeof receipt.ok).toBe('boolean')
  })
```

- [ ] **Step 6: Run all gates**

Run: `cd ~/dsh-cae && pnpm build && pnpm vitest run`
Expected: all PASS (structural tools' `ensureDeps(config, exec.signal)` calls still compile against the defaulted third parameter)

- [ ] **Step 7: Commit**

```bash
git add python/dsh_cae/deps.py pytest/test_deps.py src/runner.ts src/config.ts tests/deps.test.ts
git commit -m "feat: structural/cfd dependency groups with OpenFOAM environment probe"
```

---

### Task 3: `cfd_mesh` stage (blockMesh + checkMesh)

**Files:**
- Create: `python/dsh_cae/cfd_mesh.py`
- Test: `pytest/test_cfd_mesh.py`

**Interfaces:**
- Consumes: `cfd_case.{resolve_bashrc, render_block_mesh_dict, write_case_skeleton, foam_run, parse_check_mesh, tail40}` (Task 1).
- Produces: stage CLI
  `cfd_mesh --workdir DIR --name NAME --length-mm F --width-mm F --height-mm F --cell-size-mm F [--wall-grading F] [--block-mesh-dict-file PATH] [--bashrc PATH] [--timeout-s N]`
  and receipt `{caseDir, blockMeshDictPath, boundsM, cells, maxNonOrthogonalityDeg, maxAspectRatio, checksPassed, checkMeshLogPath, logTail}`. Task 6's TS tool builds exactly this argv.

- [ ] **Step 1: Write the failing tests**

Create `pytest/test_cfd_mesh.py`:

```python
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


def test_mesh_bad_escape_dict_fails_loud(stage, workdir):
    bad = workdir / "bad.dict"
    bad.write_text("this is not a foam dict")
    proc = stage(workdir, "cfd_mesh", "--workdir", str(workdir), "--name", "bad",
                 "--length-mm", "100", "--width-mm", "20", "--height-mm", "10",
                 "--cell-size-mm", "5", "--block-mesh-dict-file", str(bad),
                 "--bashrc", BASHRC, "--timeout-s", "120")
    assert proc.returncode != 0
    assert "blockMesh failed" in proc.stderr
```

- [ ] **Step 2: Run to verify failure**

Run: `cd ~/dsh-cae && ~/miniconda3/envs/dsh-cae/bin/pytest pytest/test_cfd_mesh.py -v`
Expected: FAIL with no receipt / stage not found (`No module named 'dsh_cae.cfd_mesh'`)

- [ ] **Step 3: Implement the stage**

Create `python/dsh_cae/cfd_mesh.py`:

```python
"""CFD mesh stage: lay a parametric blockMesh case and check it. Geometry arrives
in mm and is converted to SI here — the only unit conversion in the CFD chain."""
import argparse
import pathlib
import subprocess

from dsh_cae import cfd_case
from dsh_cae.receipt import emit, fail


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--workdir", required=True)
    parser.add_argument("--name", default="duct")
    parser.add_argument("--length-mm", type=float, required=True)
    parser.add_argument("--width-mm", type=float, required=True)
    parser.add_argument("--height-mm", type=float, required=True)
    parser.add_argument("--cell-size-mm", type=float, required=True)
    parser.add_argument("--wall-grading", type=float, default=1.0)
    parser.add_argument("--block-mesh-dict-file")
    parser.add_argument("--bashrc")
    parser.add_argument("--timeout-s", type=int, default=600)
    args = parser.parse_args()

    if args.name in (".", "..") or "/" in args.name or "\\" in args.name:
        fail(f"case name '{args.name}' must be a plain directory name")
    bashrc = cfd_case.resolve_bashrc(args.bashrc)
    case_dir = pathlib.Path(args.workdir) / "cfd" / args.name
    case_dir.mkdir(parents=True, exist_ok=True)

    if args.block_mesh_dict_file:
        dict_text = pathlib.Path(args.block_mesh_dict_file).read_text()
    else:
        dict_text = cfd_case.render_block_mesh_dict(
            args.length_mm / 1000.0, args.width_mm / 1000.0,
            args.height_mm / 1000.0, args.cell_size_mm / 1000.0, args.wall_grading)
    cfd_case.write_case_skeleton(case_dir, dict_text)

    try:
        meshed = cfd_case.foam_run(bashrc, "blockMesh", ["-case", str(case_dir)], args.timeout_s)
    except subprocess.TimeoutExpired:
        fail(f"blockMesh timed out after {args.timeout_s}s")
    (case_dir / "blockMesh.log").write_text(meshed.stdout + meshed.stderr)
    if meshed.returncode != 0:
        fail(f"blockMesh failed with exit {meshed.returncode}:\n"
             f"{cfd_case.tail40(meshed.stdout + meshed.stderr)}")

    try:
        checked = cfd_case.foam_run(bashrc, "checkMesh", ["-case", str(case_dir)], args.timeout_s)
    except subprocess.TimeoutExpired:
        fail(f"checkMesh timed out after {args.timeout_s}s")
    check_log = case_dir / "checkMesh.log"
    check_log.write_text(checked.stdout + checked.stderr)

    metrics = cfd_case.parse_check_mesh(checked.stdout)
    emit({
        "caseDir": str(case_dir),
        "blockMeshDictPath": str(case_dir / "system" / "blockMeshDict"),
        "boundsM": metrics["boundsM"],
        "cells": metrics["cells"],
        "maxNonOrthogonalityDeg": metrics["maxNonOrthogonalityDeg"],
        "maxAspectRatio": metrics["maxAspectRatio"],
        "checksPassed": metrics["checksPassed"],
        "checkMeshLogPath": str(check_log),
        "logTail": cfd_case.tail40(checked.stdout),
    })


if __name__ == "__main__":
    main()
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd ~/dsh-cae && ~/miniconda3/envs/dsh-cae/bin/pytest pytest/test_cfd_mesh.py -v`
Expected: 4 PASS

- [ ] **Step 5: Commit**

```bash
git add python/dsh_cae/cfd_mesh.py pytest/test_cfd_mesh.py
git commit -m "feat: cfd_mesh stage (blockMesh + checkMesh, mm→m at the boundary)"
```

---

### Task 4: `cfd_steady` stage (foamRun + foamToVTK)

**Files:**
- Create: `python/dsh_cae/cfd_steady.py`
- Test: `pytest/test_cfd_steady.py`

**Interfaces:**
- Consumes: `cfd_case.{resolve_bashrc, write_fields, write_control_dict, apply_overrides, foam_run, parse_foam_log, find_latest_vtk, tail40}` (Task 1); a case laid by `cfd_mesh` (Task 3).
- Produces: stage CLI
  `cfd_steady --case-dir DIR --velocity u,v,w --nu F [--rho F] [--iterations N] [--overrides-file PATH] [--case NAME] [--bashrc PATH] [--timeout-s N]`
  and receipt `{caseDir, logPath, vtkPath, iterationsRun, converged, finalResiduals: {p, U}, wallMs, exitCode, logTail, densityKgM3}`. Task 6's TS tool builds exactly this argv.

- [ ] **Step 1: Write the failing tests**

Create `pytest/test_cfd_steady.py`:

```python
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
        {"file": "system/controlDict", "entry": "endTime", "dict": "endTime 5;"}]))
    proc = _solve(stage, workdir, case_dir, "--overrides-file", str(ov), "--case", "short")
    receipt = parse_receipt(proc)
    # --iterations wrote 300; the override then pinned endTime to 5
    assert receipt["iterationsRun"] == 5
    assert "endTime         5;" in (pathlib.Path(case_dir) / "system" / "controlDict").read_text()
    assert receipt["logPath"].endswith("short.foam.log")


def test_steady_rejects_out_of_whitelist_override(stage, workdir):
    case_dir = _case(stage, workdir, parse_receipt, "s3")
    ov = workdir / "evil.json"
    ov.write_text(json.dumps([{"file": "../evil", "entry": "x", "dict": "x 1;"}]))
    proc = _solve(stage, workdir, case_dir, "--overrides-file", str(ov))
    assert proc.returncode != 0
    assert "not an overridable case file" in proc.stderr


def test_steady_rejects_missing_entry_override(stage, workdir):
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


def test_steady_reports_domain_outcome_without_dying(stage, workdir, parse_receipt):
    # nu = 0 with fixedValue inlet drives a degenerate solve; whatever foamRun
    # does, the stage must answer with a receipt, not crash.
    case_dir = _case(stage, workdir, parse_receipt, "s5")
    proc = stage(workdir, "cfd_steady", "--case-dir", case_dir,
                 "--velocity", "0.02,0,0", "--nu", "0", "--iterations", "3",
                 "--case", "degenerate", "--bashrc", BASHRC, "--timeout-s", "300")
    receipt = parse_receipt(proc)
    assert "exitCode" in receipt and "logTail" in receipt
```

- [ ] **Step 2: Run to verify failure**

Run: `cd ~/dsh-cae && ~/miniconda3/envs/dsh-cae/bin/pytest pytest/test_cfd_steady.py -v`
Expected: FAIL (`No module named 'dsh_cae.cfd_steady'`)

- [ ] **Step 3: Implement the stage**

Create `python/dsh_cae/cfd_steady.py`:

```python
"""CFD steady stage: parameterize the laid case (fields, nu, iterations), apply
dict overrides, run foamRun (incompressibleFluid = simpleFoam successor in
OpenFOAM >= 11), and convert the final time to VTK. Non-convergence and solver
crashes are domain outcomes carried in the receipt."""
import argparse
import json
import pathlib
import subprocess
import time

from dsh_cae import cfd_case
from dsh_cae.receipt import emit, fail


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--case-dir", required=True)
    parser.add_argument("--velocity", required=True, help="u,v,w in m/s")
    parser.add_argument("--nu", type=float, required=True, help="kinematic viscosity m^2/s")
    parser.add_argument("--rho", type=float, default=1.0, help="density kg/m^3 (echoed for post)")
    parser.add_argument("--iterations", type=int, default=2000)
    parser.add_argument("--overrides-file")
    parser.add_argument("--case", default="run")
    parser.add_argument("--bashrc")
    parser.add_argument("--timeout-s", type=int, default=1800)
    args = parser.parse_args()

    case_dir = pathlib.Path(args.case_dir)
    if not (case_dir / "system" / "controlDict").is_file():
        fail(f"'{case_dir}' is not a cfd_mesh case (system/controlDict missing)")
    vel = [float(v) for v in args.velocity.split(",")]
    if len(vel) != 3:
        fail(f"--velocity must be u,v,w (m/s), got '{args.velocity}'")
    if args.iterations <= 0:
        fail(f"--iterations must be positive, got {args.iterations}")
    if args.case in (".", "..") or "/" in args.case or "\\" in args.case:
        fail(f"case stem '{args.case}' must not contain path separators")

    bashrc = cfd_case.resolve_bashrc(args.bashrc)
    cfd_case.write_fields(case_dir, vel, args.nu)
    cfd_case.write_control_dict(case_dir, args.iterations)
    if args.overrides_file:
        overrides = json.loads(pathlib.Path(args.overrides_file).read_text())
        cfd_case.apply_overrides(case_dir, overrides)

    log_path = case_dir / f"{args.case}.foam.log"
    start = time.monotonic()
    try:
        run = cfd_case.foam_run(bashrc, "foamRun", ["-case", str(case_dir)], args.timeout_s)
    except subprocess.TimeoutExpired:
        fail(f"foamRun timed out after {args.timeout_s}s")
    wall_ms = int((time.monotonic() - start) * 1000)
    log_text = run.stdout + run.stderr
    log_path.write_text(log_text)

    vtk_path = None
    if run.returncode == 0:
        try:
            conv = cfd_case.foam_run(bashrc, "foamToVTK", ["-case", str(case_dir), "-latestTime"],
                                     args.timeout_s)
        except subprocess.TimeoutExpired:
            fail(f"foamToVTK timed out after {args.timeout_s}s")
        if conv.returncode == 0:
            vtk_path = cfd_case.find_latest_vtk(case_dir)

    parsed = cfd_case.parse_foam_log(run.stdout)
    emit({
        "caseDir": str(case_dir),
        "logPath": str(log_path),
        "vtkPath": vtk_path,
        "iterationsRun": parsed["iterationsRun"],
        "converged": parsed["converged"],
        "finalResiduals": parsed["finalResiduals"],
        "wallMs": wall_ms,
        "exitCode": run.returncode,
        "logTail": cfd_case.tail40(log_text),
        "densityKgM3": args.rho,
    })


if __name__ == "__main__":
    main()
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd ~/dsh-cae && ~/miniconda3/envs/dsh-cae/bin/pytest pytest/test_cfd_steady.py -v`
Expected: 6 PASS. If `test_steady_converges_and_writes_vtk` fails on convergence, loosen nothing in the templates — verify the override landed in `system/fvSolution` and read `<case>/run.foam.log` before changing code.

- [ ] **Step 5: Commit**

```bash
git add python/dsh_cae/cfd_steady.py pytest/test_cfd_steady.py
git commit -m "feat: cfd_steady stage (foamRun incompressibleFluid + dict overrides + foamToVTK)"
```

---

### Task 5: `cae_post_process` CFD fields (velocity/pressure/densityKgM3)

**Files:**
- Modify: `python/dsh_cae/post.py`
- Modify: `src/tools/post.ts`
- Test: `pytest/test_post.py` (extend), `tests/tools-solve-post.test.ts` (extend)

**Interfaces:**
- Consumes: nothing new from Tasks 1–4 (works on any `.vtk`/`.vtu` whose point data carries `U`/`p`).
- Produces: python argv `--density-kg-m3 F` (default 1.0); fields `velocity` (alias `U`, m/s) and `pressure` (alias `p`, Pa after ×density); receipt values carry `atM` (meters) for velocity/pressure instead of `atMm`; TS tool field enum + `velocity`/`pressure`, probe key `point` (renamed from `pointMm`), parameter `densityKgM3`.

- [ ] **Step 1: Write the failing tests**

Extend `pytest/test_post.py` — append:

```python
def _synthetic_cfd_vtk(path):
    import numpy as np
    import pyvista as pv
    grid = pv.ImageData(dimensions=(41, 5, 5), spacing=(0.025, 0.005, 0.005),
                        origin=(0, 0, 0)).cast_to_unstructured_grid()
    u = np.zeros((grid.n_points, 3))
    u[:, 0] = 0.02
    grid.point_data["U"] = u
    grid.point_data["p"] = np.linspace(2.8e-3, 0.0, grid.n_points)  # kinematic m²/s²
    grid.save(path)


def test_post_reads_cfd_velocity_and_pressure_with_density(stage, workdir, parse_receipt):
    vtk = workdir / "duct.vtk"
    _synthetic_cfd_vtk(vtk)
    proc = stage(workdir, "post", "--vtu", str(vtk), "--png-stem", "duct",
                 "--density-kg-m3", "1000",
                 "--max", "velocity", "--max", "pressure",
                 "--probe", "pressure,0.9,0.01,0.01", "--probe", "velocity,0.5,0.01,0.01")
    receipt = parse_receipt(proc)
    maxima = {v["field"]: v for v in receipt["values"] if v["kind"] == "max"}
    assert maxima["velocity"]["value"] == pytest.approx(0.02)
    assert maxima["velocity"]["unit"] == "m/s"
    assert maxima["velocity"]["atM"] == [0.0, 0.0, 0.0]  # uniform field: argmax is point 0
    assert "atMm" not in maxima["velocity"]
    assert maxima["pressure"]["unit"] == "Pa"
    # kinematic p × 1000 → Pa; max sits at x=0 where p=2.8e-3
    assert maxima["pressure"]["value"] == pytest.approx(2.8)
    probed = [v for v in receipt["values"] if v["kind"] == "probe" and v["field"] == "pressure"][0]
    assert probed["atM"][0] == pytest.approx(0.9, abs=0.026)


def test_post_pressure_without_density_is_kinematic(stage, workdir, parse_receipt):
    vtk = workdir / "duct.vtk"
    _synthetic_cfd_vtk(vtk)
    proc = stage(workdir, "post", "--vtu", str(vtk), "--png-stem", "duct",
                 "--max", "pressure")
    receipt = parse_receipt(proc)
    assert receipt["values"][0]["value"] == pytest.approx(2.8e-3)
    assert receipt["values"][0]["unit"] == "Pa"
```

`pressure` becomes a known field in this task, so the existing unknown-field test must move to a genuinely unknown name (and now also pins the known-but-missing message) — replace `test_post_unknown_field_lists_available` with:

```python
def test_post_unknown_and_missing_fields_list_available(stage, workdir):
    vtu = workdir / "syn.vtu"
    _synthetic_vtu(vtu)
    proc = stage(workdir, "post", "--vtu", str(vtu), "--png-stem", "syn", "--max", "banana")
    assert proc.returncode == 1
    assert "unknown field 'banana'" in proc.stderr
    assert "available point data" in proc.stderr
    proc = stage(workdir, "post", "--vtu", str(vtu), "--png-stem", "syn", "--max", "velocity")
    assert proc.returncode == 1
    assert "field 'velocity' not found" in proc.stderr
    assert "available point data" in proc.stderr
```

And add a test pinning the structural `atMm` key is unchanged:

```python
def test_post_structural_locations_stay_atMm(stage, workdir, parse_receipt):
    vtu = workdir / "syn.vtu"
    _synthetic_vtu(vtu)
    proc = stage(workdir, "post", "--vtu", str(vtu), "--png-stem", "syn", "--max", "stressXX")
    receipt = parse_receipt(proc)
    assert receipt["values"][0]["atMm"] is not None
    assert "atM" not in receipt["values"][0]
```

Extend `tests/tools-solve-post.test.ts` with a deterministic schema-rejection test (the stage never starts, so it passes on any machine):

```typescript
describe('cae_post_process CFD fields', () => {
  it('rejects probes using the old pointMm key', async () => {
    const post = defineCaePostTool({ python: 'python3', workdir: './cae-stub', stageTimeoutMs: 1000 })
    await expect(post.execute(
      { vtu: 'duct.vtk', probes: [{ field: 'velocity', pointMm: [1, 2, 3] } as never] },
      { signal: new AbortController().signal } as ToolRunContext,
    )).rejects.toThrow()
  })
})
```

- [ ] **Step 2: Run to verify failure**

Run: `cd ~/dsh-cae && PYVISTA_OFF_SCREEN=true ~/miniconda3/envs/dsh-cae/bin/pytest pytest/test_post.py -v`
Expected: new tests FAIL with `unknown field 'velocity'` / `unknown field 'pressure'`

- [ ] **Step 3: Implement the post.py extension**

In `python/dsh_cae/post.py`:

```python
# ccx2paraview (U, S), foamToVTK (U, p), and synthetic names accepted per field;
# "U" is requested as displacement for structural results and as velocity for
# CFD results — the requested field name decides the interpretation.
ALIASES = {
    "displacement": ["displacement", "disp", "DISP", "U"],
    "stress": ["stress", "STRESS", "stress_tensor", "S"],
    "velocity": ["velocity", "U"],
    "pressure": ["pressure", "p"],
}
```

`_find` gains a `density` parameter, the velocity/pressure branches, and an updated final fail. Replace the whole function with:

```python
def _find(mesh, wanted: str, density: float = 1.0):
    import numpy as np
    keys = list(mesh.point_data)
    if wanted == "displacement":
        for alias in ALIASES["displacement"]:
            if alias in mesh.point_data:
                return np.asarray(mesh.point_data[alias]).reshape(-1, 3)
        fail(f"field 'displacement' not found; available point data: {keys}")
    if wanted == "velocity":
        for alias in ALIASES["velocity"]:
            if alias in mesh.point_data:
                return np.asarray(mesh.point_data[alias]).reshape(-1, 3)
        fail(f"field 'velocity' not found; available point data: {keys}")
    if wanted == "pressure":
        # simpleFoam/foamRun output is kinematic p (m²/s²); ×density → Pa.
        for alias in ALIASES["pressure"]:
            if alias in mesh.point_data:
                return np.asarray(mesh.point_data[alias]).reshape(-1) * density
        fail(f"field 'pressure' not found; available point data: {keys}")
    if wanted in STRESS_COMPONENTS:
        # Direct scalar first: datasets may ship the exact component name
        # (synthetic fixtures) or a solver-computed "S_Mises" (ccx2paraview).
        direct = {"vonMises": [wanted, "S_Mises"]}.get(wanted, [wanted])
        for name in direct:
            if name in mesh.point_data:
                return np.asarray(mesh.point_data[name]).reshape(-1)
        for alias in ALIASES["stress"]:
            if alias in mesh.point_data:
                tensor = np.asarray(mesh.point_data[alias]).reshape(-1, 6)
                if wanted == "vonMises":
                    xx, yy, zz, xy, yz, xz = (tensor[:, i] for i in range(6))
                    return np.sqrt(
                        0.5 * ((xx - yy) ** 2 + (yy - zz) ** 2 + (zz - xx) ** 2)
                        + 3 * (xy ** 2 + yz ** 2 + xz ** 2),
                    )
                return tensor[:, STRESS_COMPONENTS[wanted]]
        fail(f"stress field not found for '{wanted}'; available point data: {keys}")
    fail(f"unknown field '{wanted}'; supported: displacement, velocity, pressure, "
         f"{', '.join(STRESS_COMPONENTS)}; available point data: {keys}")
```

```python
def _values_unit(field: str) -> str:
    if field in STRESS_COMPONENTS:
        return "MPa"
    if field == "velocity":
        return "m/s"
    if field == "pressure":
        return "Pa"
    return "mm"


def _location_key(field: str) -> str:
    # CFD results are SI meters; structural results stay mm.
    return "atM" if field in ("velocity", "pressure") else "atMm"
```

In `main`, add the argument and thread density/location key:

```python
    parser.add_argument("--density-kg-m3", type=float, default=1.0)
```

and in the maxima/probe loops:

```python
    for field in args.maxima:
        data = _find(mesh, field, args.density_kg_m3)
        idx = _argmax_abs(data)
        values.append({"kind": "max", "field": field, "value": float(_magnitude_at(data, idx)),
                       "unit": _values_unit(field), _location_key(field): [float(v) for v in mesh.points[idx]]})
    for spec in args.probe:
        field, x, y, z = spec.split(",")
        data = _find(mesh, field, args.density_kg_m3)
        idx = mesh.find_closest_point([float(x), float(y), float(z)])
        values.append({"kind": "probe", "field": field, "value": float(_magnitude_at(data, idx)),
                       "unit": _values_unit(field), _location_key(field): [float(v) for v in mesh.points[idx]]})
```

- [ ] **Step 4: Implement the TS post tool changes**

In `src/tools/post.ts`:
- DESCRIPTION: replace the fields sentence with `'Extract numbers and render contour plots from a solve result (VTU preferred, FRD fallback). Structural units: mm displacement, MPa stress. CFD results (from cae_cfd_steady .vtk): velocity in m/s, pressure in Pa — pass densityKgM3 (e.g. 1000 for water) to convert kinematic pressure. Fields: displacement, vonMises, stressXX/YY/ZZ/XY/YZ/XZ, velocity, pressure. `max` returns the field extreme with its location; `probe` returns the value at the closest point to [x, y, z] in the result file\'s length unit (mm structural, m CFD); `plot` writes a contour PNG (deformed shape for structural fields) for the human (you cannot see it — quote the numbers).'`
- `const FIELDS = [...existing, 'velocity', 'pressure']`
- `PostValue`: `atMm?: number[]` stays; add `atM?: number[]`
- parameters: add `densityKgM3: { type: 'number', description: 'Density kg/m³ multiplied into pressure to convert the CFD kinematic p to Pa. Default 1.' }`; in `probes.items.properties` rename `pointMm` → `point` with description `'Coordinates [x, y, z] in the result file\'s length unit (mm structural, m CFD).'`; same rename in probes description text.
- output schema values items: add `atM: { type: 'array', items: { type: 'number' } }` next to `atMm`.
- execute: `for (const p of args.probes ?? []) argv.push('--probe', `${p.field},${p.point.join(',')}`)`; add `if (args.densityKgM3 !== undefined) argv.push('--density-kg-m3', String(args.densityKgM3))`.
- render: the location suffix line becomes `${v.atMm ? ` at ${v.atMm.map(c => c.toFixed(2)).join(', ')} mm` : v.atM ? ` at ${v.atM.map(c => c.toFixed(3)).join(', ')} m` : ''}`.

- [ ] **Step 5: Run all gates**

Run: `cd ~/dsh-cae && PYVISTA_OFF_SCREEN=true ~/miniconda3/envs/dsh-cae/bin/pytest pytest/test_post.py -v && pnpm build && pnpm vitest run`
Expected: all PASS. Also run `pytest/test_solve.py` untouched-green is covered in Task 7's full sweep.

- [ ] **Step 6: Commit**

```bash
git add python/dsh_cae/post.py pytest/test_post.py src/tools/post.ts tests/tools-solve-post.test.ts
git commit -m "feat: velocity/pressure fields and densityKgM3 in cae_post_process for the CFD chain"
```

---

### Task 6: TS tools `cae_cfd_mesh` / `cae_cfd_steady` + wiring

**Files:**
- Create: `src/tools/cfd-mesh.ts`, `src/tools/cfd-steady.ts`
- Modify: `src/index.ts`, `tests/tools-solve-post.test.ts` (wiring list), `tests/tools-cfd.test.ts` (new)
- Modify: `examples/cantilever.md` — only if it shows a `pointMm` probe argument (grep first; update to `point` if present)

**Interfaces:**
- Consumes: `ensureDeps(config, signal, 'cfd')`, `runStage(config, 'cfd_mesh'|'cfd_steady', argv, ...)`, `Config.openfoamBashrc` (Task 2); stage argv contracts from Tasks 3–4.
- Produces: registered tool names `cae_cfd_mesh`, `cae_cfd_steady`; exported receipt interfaces `CfdMeshReceipt`, `CfdSteadyReceipt` (Task 7's docs and any consumer use these names).

- [ ] **Step 1: Write the failing tests**

Create `tests/tools-cfd.test.ts`:

```typescript
import { describe, expect, it } from 'vitest'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import { defineCaeCfdMeshTool } from '../src/tools/cfd-mesh.ts'
import { defineCaeCfdSteadyTool } from '../src/tools/cfd-steady.ts'

const config = { python: 'python3', workdir: './cae-stub', stageTimeoutMs: 1000 } as const
const exec = () => ({ signal: new AbortController().signal }) as ToolRunContext

describe('cae_cfd_mesh validation', () => {
  it('rejects a case name with path separators before starting Python', async () => {
    const tool = defineCaeCfdMeshTool(config)
    await expect(tool.execute({
      lengthMm: 1000, widthMm: 20, heightMm: 20, cellSizeMm: 2.5, name: '../escape',
    }, exec())).rejects.toThrow('must be a plain directory name')
  })
})

describe('cae_cfd_steady validation', () => {
  it('rejects inletVelocityMS that is not [u, v, w]', async () => {
    const tool = defineCaeCfdSteadyTool(config)
    await expect(tool.execute({
      caseDir: './cae/cfd/duct', inletVelocityMS: [0.02], kinematicViscosityM2S: 1e-6,
    }, exec())).rejects.toThrow('inletVelocityMS must be [u, v, w]')
  })

  it('rejects non-positive iterations', async () => {
    const tool = defineCaeCfdSteadyTool(config)
    await expect(tool.execute({
      caseDir: './cae/cfd/duct', inletVelocityMS: [0.02, 0, 0],
      kinematicViscosityM2S: 1e-6, iterations: 0,
    }, exec())).rejects.toThrow('iterations must be positive')
  })

  it('rejects a case stem with path separators', async () => {
    const tool = defineCaeCfdSteadyTool(config)
    await expect(tool.execute({
      caseDir: './cae/cfd/duct', inletVelocityMS: [0.02, 0, 0],
      kinematicViscosityM2S: 1e-6, case: 'a/b',
    }, exec())).rejects.toThrow('path separators')
  })
})
```

Update the wiring test in `tests/tools-solve-post.test.ts`:

```typescript
  it('apply registers exactly the six CAE tools in name order', () => {
    apply(ctx, { python: 'python3', workdir: './cae', stageTimeoutMs: 1000 })
    const names = registered.map(t => (t as { name: string }).name).sort()
    expect(names).toEqual([
      'cae_cad_build', 'cae_cfd_mesh', 'cae_cfd_steady', 'cae_mesh_generate',
      'cae_post_process', 'cae_solve_static',
    ])
  })
```

- [ ] **Step 2: Run to verify failure**

Run: `cd ~/dsh-cae && pnpm vitest run tests/tools-cfd.test.ts tests/tools-solve-post.test.ts`
Expected: FAIL — module not found `../src/tools/cfd-mesh.ts`; wiring list has 4 names

- [ ] **Step 3: Implement `src/tools/cfd-mesh.ts`**

```typescript
import { join, resolve } from 'node:path'
import { mkdir, writeFile } from 'node:fs/promises'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { ensureDeps, runStage } from '../runner.js'
import type { Config } from '../config.js'

const DESCRIPTION =
  'Generate a CFD mesh for a rectangular duct with blockMesh and validate it with checkMesh. '
  + 'Geometry in mm; the chain converts to SI meters here and stays SI afterwards. Flow along +x, '
  + 'inlet at x-min; patches are named inlet/outlet/walls. Returns caseDir (pass to cae_cfd_steady), '
  + 'cell count, and mesh quality. checksPassed=false is a mesh-quality verdict, not an error: '
  + 'refine (smaller cellSizeMm) or use wallGrading, or supply blockMeshDict — full dict text '
  + '(convertToMeters 1, patches must still be named inlet/outlet/walls) — for anything '
  + 'non-rectangular. checksPassed=null means the checkMesh output could not be parsed: read '
  + 'checkMeshLogPath yourself.'

/** Receipt shape of the `cfd_mesh` stage, pinned for the tool's output schema. */
export interface CfdMeshReceipt {
  caseDir: string
  blockMeshDictPath: string
  boundsM: { min: number[]; max: number[] } | null
  cells: number | null
  maxNonOrthogonalityDeg: number | null
  maxAspectRatio: number | null
  checksPassed: boolean | null
  checkMeshLogPath: string
  logTail: string
}

/** Build the `cae_cfd_mesh` tool bound to one deployment configuration. */
export function defineCaeCfdMeshTool(config: Config) {
  return defineTool({
    name: 'cae_cfd_mesh',
    description: DESCRIPTION,
    parameters: {
      lengthMm: { type: 'number', required: true, description: 'Duct length in mm (flow direction x).' },
      widthMm: { type: 'number', required: true, description: 'Cross-section width in mm (y).' },
      heightMm: { type: 'number', required: true, description: 'Cross-section height in mm (z).' },
      cellSizeMm: { type: 'number', required: true, description: 'Target cell edge in mm; per-direction counts are rounded.' },
      wallGrading: { type: 'number', description: 'Symmetric center-to-wall expansion ratio in y/z (1 = uniform). Default 1.' },
      blockMeshDict: { type: 'string', description: 'Full blockMeshDict text (escape hatch); overrides the parametric geometry.' },
      name: { type: 'string', description: 'Case directory name under <workdir>/cfd/. Default "duct".' },
    },
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        properties: {
          caseDir: { type: 'string', required: true },
          blockMeshDictPath: { type: 'string', required: true },
          boundsM: {
            oneOf: [{ type: 'object', additionalProperties: false, properties: {
              min: { type: 'array', items: { type: 'number' }, required: true },
              max: { type: 'array', items: { type: 'number' }, required: true },
            } }, { type: 'null' }], required: true,
          },
          cells: { oneOf: [{ type: 'integer' }, { type: 'null' }], required: true },
          maxNonOrthogonalityDeg: { oneOf: [{ type: 'number' }, { type: 'null' }], required: true },
          maxAspectRatio: { oneOf: [{ type: 'number' }, { type: 'null' }], required: true },
          checksPassed: { oneOf: [{ type: 'boolean' }, { type: 'null' }], required: true },
          checkMeshLogPath: { type: 'string', required: true },
          logTail: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: `blockMesh: ${value.cells ?? '?'} cells, max non-orthogonality `
          + `${value.maxNonOrthogonalityDeg ?? 'n/a'}°, max aspect ${value.maxAspectRatio ?? 'n/a'}, checks `
          + `${value.checksPassed === null ? 'unparsed — read checkMeshLogPath' : value.checksPassed ? 'OK' : 'FAILED (refine or escape via blockMeshDict)'}. `
          + `Case: ${value.caseDir}`,
      }],
    },
    async execute(args, exec) {
      await ensureDeps(config, exec.signal, 'cfd')
      const name = args.name ?? 'duct'
      if (name.includes('/') || name.includes('\\') || name === '.' || name === '..') {
        throw new Error(`case name '${name}' must be a plain directory name`)
      }
      const workdirAbs = resolve(config.workdir)
      await mkdir(join(workdirAbs, 'cfd'), { recursive: true })
      const argv = [
        '--workdir', workdirAbs,
        '--name', name,
        '--length-mm', String(args.lengthMm),
        '--width-mm', String(args.widthMm),
        '--height-mm', String(args.heightMm),
        '--cell-size-mm', String(args.cellSizeMm),
        '--wall-grading', String(args.wallGrading ?? 1),
      ]
      if (args.blockMeshDict) {
        const dictFile = join(workdirAbs, 'cfd', `${name}.blockMeshDict.txt`)
        await writeFile(dictFile, args.blockMeshDict, 'utf8')
        argv.push('--block-mesh-dict-file', dictFile)
      }
      if (config.openfoamBashrc) argv.push('--bashrc', config.openfoamBashrc)
      const { receipt } = await runStage(config, 'cfd_mesh', argv,
        { signal: exec.signal, logFile: `cfd.${name}.mesh.log` })
      return receipt as unknown as CfdMeshReceipt
    },
    presentCall: args => ({ card: 'terminal', title: `blockMesh ${args.name ?? 'duct'}`, description: 'CFD duct mesh' }),
  })
}
```

- [ ] **Step 4: Implement `src/tools/cfd-steady.ts`**

```typescript
import { join, resolve } from 'node:path'
import { writeFile } from 'node:fs/promises'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { ensureDeps, runStage } from '../runner.js'
import type { Config } from '../config.js'

const DESCRIPTION =
  'Run a steady incompressible laminar solve (simpleFoam-successor foamRun) on a cae_cfd_mesh case. '
  + 'SI units: velocity m/s, kinematic viscosity m²/s, density kg/m³. A converged=false result is '
  + 'a normal outcome: raise iterations or override system/fvSolution\'s SIMPLE block (e.g. looser '
  + 'residualControl) and retry; exitCode!=0 carries logTail for diagnosis. densityKgM3 is echoed — '
  + 'pass the same value to cae_post_process so kinematic pressure converts to Pa. overrides replace '
  + 'top-level entries in whitelisted case dicts, exactly and only.'

const OVERRIDE_FILES = [
  'system/controlDict', 'system/fvSchemes', 'system/fvSolution',
  'system/blockMeshDict', 'constant/physicalProperties', 'constant/momentumTransport',
] as const

/** Receipt shape of the `cfd_steady` stage, pinned for the tool's output schema. */
export interface CfdSteadyReceipt {
  caseDir: string
  logPath: string
  vtkPath: string | null
  iterationsRun: number
  converged: boolean
  finalResiduals: { p: number | null; U: number | null }
  wallMs: number
  exitCode: number
  logTail: string
  densityKgM3: number
}

/** Build the `cae_cfd_steady` tool bound to one deployment configuration. */
export function defineCaeCfdSteadyTool(config: Config) {
  return defineTool({
    name: 'cae_cfd_steady',
    description: DESCRIPTION,
    parameters: {
      caseDir: { type: 'string', required: true, description: 'caseDir from cae_cfd_mesh.' },
      inletVelocityMS: {
        type: 'array', items: { type: 'number' }, required: true,
        description: 'Inlet velocity [u, v, w] in m/s.',
      },
      kinematicViscosityM2S: {
        type: 'number', required: true,
        description: 'Kinematic viscosity ν in m²/s (water ≈ 1e-6, air ≈ 1.5e-5).',
      },
      densityKgM3: { type: 'number', description: 'Density kg/m³, echoed for cae_post_process. Default 1.' },
      iterations: { type: 'integer', description: 'Iteration (endTime) cap. Default 2000.' },
      overrides: {
        type: 'array',
        items: {
          type: 'object', additionalProperties: false,
          properties: {
            file: { type: 'string', required: true, enum: [...OVERRIDE_FILES] },
            entry: { type: 'string', required: true, description: 'Top-level entry to replace, e.g. endTime or SIMPLE.' },
            dict: { type: 'string', required: true, description: 'Full replacement text including the entry name and trailing ";".' },
          },
        },
        description: 'Exact top-level entry replacements applied before the solve.',
      },
      case: { type: 'string', description: 'Log/VTK stem inside the case. Default "run".' },
    },
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        properties: {
          caseDir: { type: 'string', required: true },
          logPath: { type: 'string', required: true },
          vtkPath: { oneOf: [{ type: 'string' }, { type: 'null' }], required: true },
          iterationsRun: { type: 'integer', required: true },
          converged: { type: 'boolean', required: true },
          finalResiduals: {
            type: 'object', additionalProperties: false, required: true,
            properties: {
              p: { oneOf: [{ type: 'number' }, { type: 'null' }], required: true },
              U: { oneOf: [{ type: 'number' }, { type: 'null' }], required: true },
            },
          },
          wallMs: { type: 'integer', required: true },
          exitCode: { type: 'integer', required: true },
          logTail: { type: 'string', required: true },
          densityKgM3: { type: 'number', required: true },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: `foamRun exit ${value.exitCode} — `
          + (value.converged
            ? `converged in ${value.iterationsRun} iterations`
            : `NOT converged after ${value.iterationsRun} iterations (p ${value.finalResiduals.p ?? 'n/a'}, `
              + `U ${value.finalResiduals.U ?? 'n/a'}) — raise iterations or override SIMPLE`)
          + `. Results: ${value.vtkPath ?? value.logPath}`,
      }],
      presentationMeta: (_args, value) => ({ exitCode: value.exitCode, logTail: value.logTail }),
    },
    async execute(args, exec) {
      if (args.inletVelocityMS.length !== 3) {
        throw new Error(`inletVelocityMS must be [u, v, w], got ${JSON.stringify(args.inletVelocityMS)}`)
      }
      const iterations = args.iterations ?? 2000
      if (!Number.isInteger(iterations) || iterations <= 0) {
        throw new Error(`iterations must be a positive integer, got ${iterations}`)
      }
      const stem = args.case ?? 'run'
      if (stem.includes('/') || stem.includes('\\')) {
        throw new Error(`case stem '${stem}' must not contain path separators`)
      }
      await ensureDeps(config, exec.signal, 'cfd')
      const caseDir = resolve(args.caseDir)
      const argv = [
        '--case-dir', caseDir,
        '--velocity', args.inletVelocityMS.join(','),
        '--nu', String(args.kinematicViscosityM2S),
        '--rho', String(args.densityKgM3 ?? 1),
        '--iterations', String(iterations),
        '--case', stem,
      ]
      if (args.overrides?.length) {
        const ovrFile = join(caseDir, `${stem}.overrides.json`)
        await writeFile(ovrFile, JSON.stringify(args.overrides), 'utf8')
        argv.push('--overrides-file', ovrFile)
      }
      if (config.openfoamBashrc) argv.push('--bashrc', config.openfoamBashrc)
      const { receipt } = await runStage(config, 'cfd_steady', argv,
        { signal: exec.signal, logFile: `cfd.${stem}.steady.log` })
      return receipt as unknown as CfdSteadyReceipt
    },
    presentCall: args => ({ card: 'terminal', title: `foamRun ${args.case ?? 'run'}`, description: 'Steady incompressible solve' }),
    presentResult: (_args, { meta }) => {
      const m = meta as { exitCode?: number; logTail?: string } | undefined
      return {
        card: 'terminal',
        output: m?.logTail ?? '',
        exitCode: m?.exitCode ?? -1,
      }
    },
  })
}
```

- [ ] **Step 5: Register both tools**

In `src/index.ts`: add imports and registrations; update the docstring line `Registers four stage tools` → `Registers six stage tools (structural + CFD chains)`.

```typescript
import { defineCaeCfdMeshTool } from './tools/cfd-mesh.js'
import { defineCaeCfdSteadyTool } from './tools/cfd-steady.js'
```

and in `apply`:

```typescript
  ctx.tools.register(defineCaeCfdMeshTool(config))
  ctx.tools.register(defineCaeCfdSteadyTool(config))
```

- [ ] **Step 6: Run all gates**

Run: `cd ~/dsh-cae && grep -rn "pointMm" examples/ || true; pnpm build && pnpm vitest run`
Expected: all PASS; if the grep printed hits in `examples/cantilever.md`, update those probe args to `point` in the same commit.

- [ ] **Step 7: Commit**

```bash
git add src/tools/cfd-mesh.ts src/tools/cfd-steady.ts src/index.ts tests/tools-cfd.test.ts tests/tools-solve-post.test.ts examples/cantilever.md
git commit -m "feat: cae_cfd_mesh and cae_cfd_steady tools; six-tool wiring"
```

---

### Task 7: Shah–London acceptance pipeline

**Files:**
- Test: `pytest/test_cfd_pipeline.py` (new; no production code expected — if the numbers miss, fix the earlier stages, not the test)

**Interfaces:**
- Consumes: stages `cfd_mesh`, `cfd_steady`, `post` with the argv contracts of Tasks 3–5.
- Produces: the acceptance evidence cited by `examples/duct-flow.md` (Task 8) — ΔP/L within 5% of theory and Umax/Umean within 10% of 2.10.

- [ ] **Step 1: Write the test**

Create `pytest/test_cfd_pipeline.py`:

```python
"""Acceptance pipeline: laminar square duct vs the Shah-London exact constant.

f·Re = 56.91 for a square section. Water (nu=1e-6, rho=1000) at U=0.02 m/s in a
20x20 mm duct gives Re=400 (laminar, entrance ~0.4 m). Theory: dP/dx =
f·Re · mu·U / Dh^2 = 56.91 * 1e-3 * 0.02 / 0.02^2 ≈ 2.85 Pa/m; developed
centerline Umax/Umean = 2.10 (square-duct tabulated value).
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
DPDX_THEORY = FRE_SQUARE * (NU * RHO) * U_MEAN / SIDE ** 2  # ≈ 2.85 Pa/m
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
    # a moderately tightened residualControl instead of grinding the default
    # 1e-4/1e-5 to endTime; 1e-3/1e-4 is far tighter than the ±5% gate needs.
    overrides = workdir / "accept.overrides.json"
    overrides.write_text(json.dumps([
        {"file": "system/fvSolution", "entry": "SIMPLE",
         "dict": "SIMPLE { nNonOrthogonalCorrectors 0; consistent yes; "
                 "residualControl { p 1e-3; U 1e-4; } }"}]))
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
```

- [ ] **Step 2: Run it (real kernels)**

Run: `cd ~/dsh-cae && PYVISTA_OFF_SCREEN=true ~/miniconda3/envs/dsh-cae/bin/pytest pytest/test_cfd_pipeline.py -v`
Expected: PASS (blockMesh ~25k cells, solve well under the 120 s subprocess timeout in `conftest.py`'s `run_stage`).

If the 5% gate misses: read `accept/run.foam.log` residuals and the probe numbers. The legitimate knobs are mesh (`cellSizeMm`) and iterations — physics stays fixed. Record whatever you changed in the Task 8 example so the docs match the passing configuration.

- [ ] **Step 3: Run the full Python suite**

Run: `cd ~/dsh-cae && PYVISTA_OFF_SCREEN=true ~/miniconda3/envs/dsh-cae/bin/pytest pytest -v`
Expected: whole suite PASS (structural + cfd + pure tests)

- [ ] **Step 4: Commit**

```bash
git add pytest/test_cfd_pipeline.py
git commit -m "test: Shah-London square-duct acceptance pipeline (dP/L ±5%, Umax/Umean ±10%)"
```

---

### Task 8: Example, docs, CI, version

**Files:**
- Create: `examples/duct-flow.md`
- Modify: `README.md`, `README.zh.md`, `package.json`, `.github/workflows/ci.yml`
- Test: the TS/pytest gates plus `pnpm build` (docs have no dedicated gate; both READMEs must mirror each other exactly)

**Interfaces:**
- Consumes: final receipts of Tasks 3–6; acceptance numbers of Task 7.
- Produces: version `0.2.0`; published user-facing documentation.

- [ ] **Step 1: Write `examples/duct-flow.md`**

Model it on `examples/cantilever.md` (one Chinese driver sentence, expected flow, realistic calls with trimmed receipts). Content skeleton — fill receipts from the Task 7 passing run:

```markdown
# Demo: natural-language duct-flow simulation

Install the plugin into a profile, boot it, and paste:

> 建一个 20×20 mm 方形截面、长 1 m 的水管，水温（ν=1e-6 m²/s，ρ=1000 kg/m³），
> 入口流速 0.02 m/s。做稳态层流求解：报告充分发展段的压降梯度并与层流理论值
> （方管 f·Re=56.91，ΔP/L≈2.85 Pa/m）对比，给出中心线最大流速，并出压力云图。

Expected agent flow: `cae_cfd_mesh` → `cae_cfd_steady` → `cae_post_process`
(units: mm in, SI out — the mesh tool converts once).

## 1. Mesh the duct

```json
{ "lengthMm": 1000, "widthMm": 20, "heightMm": 20, "cellSizeMm": 2.5, "name": "duct" }
```

```json
{ "caseDir": "/tmp/cae/cfd/duct", "cells": 25600, "maxNonOrthogonalityDeg": 0, "checksPassed": true, "..." : "..." }
```

## 2. Solve

```json
{ "caseDir": "/tmp/cae/cfd/duct", "inletVelocityMS": [0.02, 0, 0], "kinematicViscosityM2S": 1e-6, "densityKgM3": 1000, "iterations": 2000 }
```

```json
{ "converged": true, "iterationsRun": <N>, "finalResiduals": { "p": <..>, "U": <..> }, "vtkPath": "/tmp/cae/cfd/duct/VTK/duct_<N>.vtk", "densityKgM3": 1000 }
```

## 3. Post-process

```json
{ "vtu": "/tmp/cae/cfd/duct/VTK/duct_<N>.vtk", "densityKgM3": 1000,
  "probes": [{ "field": "pressure", "point": [0.5, 0.01, 0.01] }, { "field": "pressure", "point": [0.9, 0.01, 0.01] }, { "field": "velocity", "point": [0.9, 0.01, 0.01] }],
  "plots": [{ "field": "pressure" }] }
```

Probes at x=0.5/0.9 m sit past the ≈0.4 m entrance length (0.05·Re·D_h at Re=400).
The ΔP between them over 0.4 m should land within 5% of 2.85 Pa/m, and centerline
Umax/Umean ≈ 2.10 (square duct) within 10% — the assertion pytest/test_cfd_pipeline.py makes.
```

- [ ] **Step 2: Update both READMEs (mirrored)**

`README.md` changes:
1. Intro paragraph: `...over build123d, Gmsh, CalculiX, and PyVista.` → mention OpenFOAM for the CFD chain; `Four tools` → `Six tools`; add one sentence: a parallel CFD chain (blockMesh → steady incompressible solve → post) handles internal-flow requests.
2. Install: after the CalculiX sentence add `For the CFD chain, OpenFOAM (Foundation v11–13 or ESI) must be installed; its `etc/bashrc` is auto-detected (`$FOAM_BASHRC`, `/opt/openfoam*`, `/usr/lib/openfoam*`) or set via `openfoamBashrc`.`
3. Try it: add `and [examples/duct-flow.md](examples/duct-flow.md): one Chinese sentence produces a laminar duct-flow solution validated against the Shah–London friction constant.`
4. `## The four tools` → `## The six tools`; add rows:

```markdown
| `cae_cfd_mesh` | duct `lengthMm`/`widthMm`/`heightMm`/`cellSizeMm` (+ `wallGrading`, full `blockMeshDict` text, `name`) | `caseDir` (SI bounds, cell count, checkMesh quality, `checksPassed`) |
| `cae_cfd_steady` | `caseDir`, `inletVelocityMS`, `kinematicViscosityM2S`, `densityKgM3`, `iterations`, dict `overrides` | solver log tail, `converged` + final residuals, VTK path |
```

5. Units section: append `The CFD chain takes geometry in mm at `cae_cfd_mesh` (converted to m once) and is SI afterwards: m, m/s, Pa, Pa·s; `cae_post_process` converts kinematic pressure to Pa when given `densityKgM3`.`
6. Configuration table: add `| `openfoamBashrc` | auto-detect | OpenFOAM `etc/bashrc` path; auto-detection checks `$FOAM_BASHRC`, `/opt/openfoam*/etc/bashrc`, `/usr/lib/openfoam/*/etc/bashrc` |`
7. Troubleshooting: add `OpenFOAM 11+ (Foundation) replaced standalone solvers: this plugin runs `foamRun` (`solver incompressibleFluid`), the simpleFoam successor; ESI releases keep `simpleFoam` but the invoked names here are Foundation's. `foamToVTK` writes legacy `.vtk`, which `cae_post_process` reads directly.`
8. Limitations: `Linear static analysis only` → `Structural: linear static analysis only; CFD: steady incompressible laminar internal flow only;` keep the rest.
9. Roadmap: remove `OpenFOAM integration`; the list becomes `CAE skill for prompt guidance, background jobs via ctx.jobs, modal/thermal analysis, turbulence (kOmegaSST + y+ treatment), snappyHexMesh/STL geometry, pluggable solver providers.`
10. Contributing "good first targets": update the OpenFOAM item to `turbulence and snappyHexMesh extensions on top of the CFD chain`.

`README.zh.md`: the exact mirror in Chinese of every change above (工具表六行、单位段补 SI 约定、配置表加 openfoamBashrc 行、故障排查加 foamRun 说明、限制与路线图同步、试一试加 duct-flow 链接).

- [ ] **Step 3: Version + CI**

`package.json`: `"version": "0.1.0"` → `"0.2.0"`, and the description gains `+ CFD (OpenFOAM)`:

```json
  "version": "0.2.0",
  "description": "DeepSeek Harness bundle: natural-language-driven CAE pipeline (CAD → mesh → solve → post-process; CFD via OpenFOAM)",
```

`.github/workflows/ci.yml` — insert after the apt calculix step:

```yaml
      - name: Install OpenFOAM (best effort; cfd tests self-skip)
        continue-on-error: true
        run: |
          wget -qO- https://dl.openfoam.org/gpg.key | sudo gpg --dearmor -o /usr/share/keyrings/openfoam.gpg
          echo "deb [signed-by=/usr/share/keyrings/openfoam.gpg] http://dl.openfoam.org/ubuntu noble main" | sudo tee /etc/apt/sources.list.d/openfoam.list
          sudo apt-get update && sudo apt-get install -y openfoam13
```

- [ ] **Step 4: Run all gates**

Run: `cd ~/dsh-cae && pnpm build && pnpm vitest run && PYVISTA_OFF_SCREEN=true ~/miniconda3/envs/dsh-cae/bin/pytest pytest -v`
Expected: everything PASS

- [ ] **Step 5: Commit**

```bash
git add examples/duct-flow.md README.md README.zh.md package.json .github/workflows/ci.yml
git commit -m "docs: duct-flow example, six-tool READMEs, OpenFOAM CI step; v0.2.0"
```

---

## Self-Review (completed during planning)

- **Spec coverage**: decisions 1–6 → Tasks 1/3/4 (physics, mesh path, bashrc), Task 6 (tool surface), Tasks 1/3/5 (units + density conversion), Task 1 (overrides), Task 2 (deps groups). Chain diagram → Tasks 3/4/6. Receipt contracts → Tasks 3/4 (python) + 6 (TS schemas). Case layout → Task 1. Testing matrix → Tasks 1/3/4/5/6/7 (+ wiring 4→6 in Task 6). CI → Task 8. Layout increments + version + roadmap → Task 8. Risk table mitigations → encoded: version-drift (long-stable utilities + module-level skips), overrides fragility (exact-match + whitelist + tests), kinematic-pressure misuse (receipt/tool-text labels + density conversion only on request), checkMesh drift (checksPassed=null + log path), apt source drift (continue-on-error + self-skip).
- **Deviations**: all seven measured on real `/opt/openfoam13` and amended into the spec in Task 1, listed in Global Constraints.
- **Type consistency**: `CfdMeshReceipt`/`CfdSteadyReceipt` (Task 6) match the python receipts (Tasks 3/4) field-for-field including `densityKgM3`; `apply_overrides` consumes the same `{file, entry, dict}` shape the TS `overrides` parameter serializes; `atM`/`point` renames appear in both layers' tests.
