# python/dsh_cae/cfd_transient.py
"""CFD transient stage: lay real-time controlDict + PIMPLE + Euler schemes on a
cae_cfd_mesh case and march physical seconds with a Courant-limited adaptive
step (or a fixed deltaT). Completion (endTime reached) and stability (max
Courant seen) are reported; crashes are domain outcomes carried in the receipt."""
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
    parser.add_argument("--end-time-s", type=float, required=True)
    parser.add_argument("--write-interval-s", type=float)
    parser.add_argument("--max-co", type=float, default=0.5)
    parser.add_argument("--delta-t", type=float)
    parser.add_argument("--overrides-file")
    parser.add_argument("--case", default="run")
    parser.add_argument("--bashrc")
    parser.add_argument("--timeout-s", type=int, default=1800)
    args = parser.parse_args()

    vel = [float(v) for v in args.velocity.split(",")]
    if len(vel) != 3:
        fail(f"--velocity must be u,v,w (m/s), got '{args.velocity}'")
    if args.end_time_s <= 0:
        fail(f"--end-time-s must be positive, got {args.end_time_s}")
    if args.delta_t is not None and args.delta_t <= 0:
        fail(f"--delta-t must be positive, got {args.delta_t}")
    write_interval = args.write_interval_s or args.end_time_s / 10.0
    if write_interval <= 0 or write_interval > args.end_time_s:
        fail(f"--write-interval-s must be in (0, end-time-s], got {write_interval}")
    if args.case in (".", "..") or "/" in args.case or "\\" in args.case:
        fail(f"case stem '{args.case}' must not contain path separators")
    case_dir = pathlib.Path(args.case_dir)
    if not (case_dir / "system" / "controlDict").is_file():
        fail(f"'{case_dir}' is not a cfd_mesh case (system/controlDict missing)")

    # Rerun hygiene: stale time dirs poison foamToVTK -latestTime (same as steady).
    for entry in case_dir.iterdir():
        if entry.name != "0" and re.fullmatch(r"\d+(\.\d+)?", entry.name) and entry.is_dir():
            shutil.rmtree(entry)
    shutil.rmtree(case_dir / "VTK", ignore_errors=True)

    bashrc = cfd_case.resolve_bashrc(args.bashrc)
    cfd_case.write_fields(case_dir, vel, args.nu)
    (case_dir / "system" / "fvSchemes").write_text(cfd_case.FV_SCHEMES_TRANSIENT)
    (case_dir / "system" / "fvSolution").write_text(cfd_case.FV_SOLUTION_TRANSIENT)
    cfd_case.write_control_dict_transient(case_dir, args.end_time_s, args.delta_t,
                                          args.max_co, write_interval)
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

    parsed = cfd_case.parse_transient_log(run.stdout)
    residuals = cfd_case.parse_foam_log(run.stdout)["finalResiduals"]
    emit({
        "caseDir": str(case_dir),
        "logPath": str(log_path),
        "vtkPath": vtk_path,
        "timeStepsRun": parsed["timeStepsRun"],
        "simTimeS": parsed["simTimeS"],
        "endTimeS": args.end_time_s,
        "maxCourantSeen": parsed["maxCourantSeen"],
        "finalResiduals": residuals,
        "wallMs": wall_ms,
        "exitCode": run.returncode,
        "logTail": cfd_case.tail40(log_text),
        "densityKgM3": args.rho,
    })


if __name__ == "__main__":
    main()
