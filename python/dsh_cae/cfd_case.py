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
    """Iteration count, convergence marker, and final-iteration residuals (U = max
    component present in the last Time block; components absent from it, e.g. an
    early-only Uy, do not count)."""
    steps = list(re.finditer(r"^Time = ", text, re.M))
    last_step = text[steps[-1].start():] if steps else text
    final_re = r", Final residual = ([0-9.eE+-]+),"
    u_finals = [v for v in (
        _last_float(last_step, rf"Solving for {c}, Initial residual = [0-9.eE+-]+{final_re}")
        for c in ("Ux", "Uy", "Uz")
    ) if v is not None]
    return {
        "iterationsRun": len(steps),
        "converged": "solution converged" in text,
        "finalResiduals": {
            "p": _last_float(last_step, rf"Solving for p, Initial residual = [0-9.eE+-]+{final_re}"),
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


FV_SCHEMES_TRANSIENT = _foam_header("dictionary", "fvSchemes", "system") + """
ddtSchemes
{
    default         Euler;
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

FV_SOLUTION_TRANSIENT = _foam_header("dictionary", "fvSolution", "system") + """
solvers
{
    p
    {
        solver          GAMG;
        tolerance       1e-06;
        relTol          0.1;
        smoother        GaussSeidel;
    }

    pFinal
    {
        $p;
        relTol          0;
    }

    U
    {
        solver          smoothSolver;
        smoother        symGaussSeidel;
        tolerance       1e-05;
        relTol          0.1;
    }

    UFinal
    {
        $U;
        relTol          0;
    }
}

PIMPLE
{
    momentumPredictor   yes;
    nOuterCorrectors    1;
    nCorrectors         2;
    nNonOrthogonalCorrectors 1;
}
"""


def write_control_dict_transient(case_dir: pathlib.Path, end_time_s: float,
                                 delta_t_s: float | None, max_co: float,
                                 write_interval_s: float) -> None:
    """Transient controlDict: real physical seconds; Courant-limited adaptive
    deltaT unless a fixed deltaT is given. purgeWrite 0 keeps history."""
    if delta_t_s is not None:
        stepping = f"adjustTimeStep  no;\ndeltaT          {delta_t_s:.6g};"
    else:
        stepping = ("adjustTimeStep  yes;\ndeltaT          1e-05;\n"
                    f"maxCo           {max_co:.6g};\nmaxDeltaT       {write_interval_s:.6g};")
    (case_dir / "system").mkdir(parents=True, exist_ok=True)
    (case_dir / "system" / "controlDict").write_text(
        _foam_header("dictionary", "controlDict", "system")
        + f"""
solver          incompressibleFluid;

startFrom       startTime;
startTime       0;
stopAt          endTime;
endTime         {end_time_s:.6g};
{stepping}

writeControl    adjustableRunTime;
writeInterval   {write_interval_s:.6g};

purgeWrite      0;
writeFormat     ascii;
writePrecision  6;
writeCompression off;
timeFormat      general;
timePrecision   6;
runTimeModifiable true;
""")


def parse_transient_log(text: str) -> dict:
    """Time-step count, final simulated seconds, and the max Courant number
    seen (transient foamRun logs carry 'Courant Number mean: x max: y')."""
    times = re.findall(r"^Time = ([0-9.eE+-]+)", text, re.M)
    cours = [float(m) for m in
             re.findall(r"Courant Number mean: [0-9.eE+-]+ max: ([0-9.eE+-]+)", text)]
    return {
        "timeStepsRun": len(times),
        "simTimeS": float(times[-1]) if times else 0.0,
        "maxCourantSeen": max(cours) if cours else None,
    }
