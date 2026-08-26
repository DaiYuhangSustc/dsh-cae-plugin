"""Dependency self-check stage: structural probes imports + ccx, cfd probes the
OpenFOAM environment (bashrc resolvable and blockMesh/checkMesh/foamRun/foamToVTK on PATH)."""
import argparse
import subprocess

from dsh_cae import cfd_case
from dsh_cae.receipt import emit

PY_DEPS = ["build123d", "gmsh", "pyvista", "ccx2paraview"]

#: Utilities the cfd chain drives; all are stable across Foundation and ESI releases.
FOAM_UTILS = ["blockMesh", "checkMesh", "foamRun", "foamToVTK"]


def check_structural() -> tuple[list[str], dict]:
    """Probe python imports and ccx; return (missing, diagnostics).

    Diagnostics answer the two questions every real failure raised so far:
    WHICH interpreter ran the check, and WHY each import actually failed
    (e.g. a poisoned LD_LIBRARY_PATH surfaces as a pyexpat symbol error, not
    as a missing package).
    """
    import sys
    missing: list[str] = []
    details: dict[str, str] = {}
    for mod in PY_DEPS:
        try:
            __import__(mod)
        except ImportError as exc:
            missing.append(mod)
            details[mod] = f"{type(exc).__name__}: {exc}"
        except Exception as exc:  # noqa: BLE001 - broken installs fail elsewhere in the chain
            missing.append(mod)
            details[mod] = f"{type(exc).__name__}: {exc}"
    import shutil
    ccx_path = shutil.which("ccx")
    if ccx_path is None:
        missing.append("ccx (CalculiX binary)")
    diag = {
        "python": sys.executable,
        "pythonVersion": sys.version.split()[0],
        "ccxPath": ccx_path,
        "importErrors": details,
    }
    return missing, diag


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
    if args.group == "structural":
        missing, diag = check_structural()
        emit({"ok": not missing, "missing": missing, "group": args.group, "diagnostics": diag})
    else:
        missing = check_cfd(args.bashrc)
        emit({"ok": not missing, "missing": missing, "group": args.group})


if __name__ == "__main__":
    main()
