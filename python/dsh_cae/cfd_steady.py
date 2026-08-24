"""CFD steady stage: parameterize the laid case (fields, nu, iterations), apply
dict overrides, run foamRun (incompressibleFluid = simpleFoam successor in
OpenFOAM >= 11), and convert the final time to VTK. Non-convergence and solver
crashes are domain outcomes carried in the receipt."""
import argparse
import json
import pathlib
import re
import shutil
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

    # Rerun hygiene: a longer previous run leaves time dirs (and VTK output)
    # that foamToVTK -latestTime would otherwise pick up as the new result.
    for entry in case_dir.iterdir():
        if entry.name != "0" and re.fullmatch(r"\d+(\.\d+)?", entry.name) and entry.is_dir():
            shutil.rmtree(entry)
    shutil.rmtree(case_dir / "VTK", ignore_errors=True)

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
