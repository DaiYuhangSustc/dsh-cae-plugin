"""Solve stage: MSH in, CalculiX *STATIC run out; ccx failure is a domain outcome."""
import argparse
import os
import subprocess
import sys
import time

from dsh_cae.receipt import emit, fail

TET_TYPES = {4: "C3D4", 11: "C3D10"}


def emit_elements(gmsh, lines: list, tag_to_i: dict) -> str:
    """Append *ELEMENT blocks for every volume entity; returns the element keyword used."""
    keyword = None
    for _dim, vtag in gmsh.model.getEntities(3):
        types, etags, enodes = gmsh.model.mesh.getElements(3, vtag)
        for etype, tags, nodes in zip(types, etags, enodes):
            keyword = TET_TYPES.get(int(etype))
            if keyword is None:
                fail(f"mesh contains unsupported element type {etype}; only linear/quadratic tets are supported")
            lines.append(f"*ELEMENT, TYPE={keyword}, ELSET=EALL")
            width = len(nodes) // len(tags)
            for k, etag in enumerate(tags):
                conn = list(nodes[k * width:(k + 1) * width])
                if width == 10:
                    # Gmsh orders the last two mid-edge nodes as (3-4),(2-4);
                    # Abaqus/CalculiX C3D10 wants (2-4),(3-4). Without the swap
                    # ccx reports nonpositive jacobian in every element.
                    conn[8], conn[9] = conn[9], conn[8]
                ids = ",".join(str(int(n)) for n in conn)
                lines.append(f"{int(etag)}, {ids}")
    if keyword is None:
        fail("mesh contains no volume elements")
    return keyword


def group_node_tags(gmsh, name: str) -> list:
    """Node tags belonging to a dim-2 physical group by name; fail loud when absent."""
    for dim, tag in gmsh.model.getPhysicalGroups():
        if gmsh.model.getPhysicalName(dim, tag) == name:
            if dim != 2:
                fail(f"boundary group '{name}' must be a surface (dim 2) group")
            tags, _nodes = gmsh.model.mesh.getNodesForPhysicalGroup(2, tag)
            return [int(t) for t in tags]
    fail(f"physical group '{name}' not found in mesh")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--msh", required=True)
    parser.add_argument("--case", required=True)
    parser.add_argument("--young-mpa", type=float, required=True)
    parser.add_argument("--poisson", type=float, required=True)
    parser.add_argument("--fixed-group", action="append", default=[])
    parser.add_argument("--load-group", action="append", default=[])
    parser.add_argument("--load-n", action="append", default=[])
    parser.add_argument("--script-file")
    args = parser.parse_args()

    try:
        import gmsh
    except ImportError as exc:
        fail(f"gmsh is not installed in this interpreter: {exc}")
    if len(args.load_group) != len(args.load_n):
        fail("--load-group and --load-n must appear in pairs")

    # CalculiX dislikes absolute jobnames: run ccx with the bare basename from the
    # case's own directory and report absolute artifact paths in the receipt.
    case_abs = os.path.abspath(args.case)
    case_dir = os.path.dirname(case_abs)
    case_base = os.path.basename(case_abs)

    gmsh.initialize()
    lines: list[str] = []
    try:
        gmsh.open(args.msh)

        node_tags, coords, _param = gmsh.model.mesh.getNodes()
        lines.append("*NODE")
        for i, t in enumerate(node_tags):
            x, y, z = coords[3 * i], coords[3 * i + 1], coords[3 * i + 2]
            lines.append(f"{int(t)}, {x:.9g}, {y:.9g}, {z:.9g}")
        emit_elements(gmsh, lines, {})

        fixed_nodes: list[int] = []
        for name in args.fixed_group:
            fixed_nodes.extend(group_node_tags(gmsh, name))
        if fixed_nodes:
            lines.append(f"*NSET, NSET=NFIXED")
            for start in range(0, len(fixed_nodes), 8):
                lines.append(", ".join(str(n) for n in fixed_nodes[start:start + 8]))

        loads: list[tuple[str, tuple[float, float, float], list[int]]] = []
        for name, vec in zip(args.load_group, args.load_n):
            fx, fy, fz = (float(v) for v in vec.split(","))
            loads.append((name, (fx, fy, fz), group_node_tags(gmsh, name)))

        lines += [
            "*MATERIAL, NAME=MAT",
            "*ELASTIC",
            f"{args.young_mpa:.9g}, {args.poisson:.9g}",
            "*SOLID SECTION, ELSET=EALL, MATERIAL=MAT",
        ]
        if fixed_nodes:
            lines += ["*BOUNDARY", "NFIXED, 1, 3, 0.0"]

        if args.script_file:
            with open(args.script_file, encoding="utf-8") as handle:
                lines.append(handle.read().strip())

        lines.append("*STEP")
        lines.append("*STATIC")
        for _name, (fx, fy, fz), nodes in loads:
            per_node = len(nodes) or 1
            for n in nodes:
                # N split evenly over the group's nodes; consistent with St. Venant
                # for tip deflection, exact for total force.
                lines.append(f"*CLOAD\n{n}, 1, {fx / per_node:.9g}\n{n}, 2, {fy / per_node:.9g}\n{n}, 3, {fz / per_node:.9g}")
        lines += ["*NODE FILE", "U, RF", "*EL FILE", "S", "*END STEP"]

        inp_path = os.path.join(case_dir, case_base + ".inp")
        with open(inp_path, "w", encoding="utf-8") as handle:
            handle.write("\n".join(lines) + "\n")
    finally:
        gmsh.finalize()

    start = time.monotonic()
    proc = subprocess.run(["ccx", case_base], cwd=case_dir, capture_output=True,
                          text=True, timeout=None)
    wall_ms = int((time.monotonic() - start) * 1000)
    log_text = (proc.stdout or "") + (proc.stderr or "")
    log_path = os.path.join(case_dir, case_base + ".log")
    with open(log_path, "w", encoding="utf-8") as handle:
        handle.write(log_text)

    frd_path = os.path.join(case_dir, case_base + ".frd")
    vtu_path: str | None = None
    if proc.returncode == 0:
        try:
            from ccx2paraview import Converter
            Converter(frd_path, ["vtu"]).run()
            vtu_path = os.path.join(case_dir, case_base + ".vtu")
        except Exception as exc:  # noqa: BLE001 - conversion is best-effort; frd stays usable
            print(f"frd->vtu conversion failed: {exc}", file=sys.stderr)
            vtu_path = None

    tail_lines = "\n".join(log_text.strip().splitlines()[-40:])[-8192:]
    emit({
        "inpPath": inp_path,
        "frdPath": frd_path,
        "vtuPath": vtu_path,
        "exitCode": proc.returncode,
        "wallMs": wall_ms,
        "logTail": tail_lines,
    })


if __name__ == "__main__":
    main()
