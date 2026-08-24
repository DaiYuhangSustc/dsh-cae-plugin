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
    for flag in ("length_mm", "width_mm", "height_mm", "cell_size_mm"):
        value = getattr(args, flag)
        if value <= 0:
            fail(f"--{flag.replace('_', '-')} must be positive, got {value}")
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
