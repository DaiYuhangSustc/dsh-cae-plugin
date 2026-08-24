"""Post stage: scalar extraction and offscreen deformed-shape plots from VTU/FRD."""
import argparse
import os

from dsh_cae.receipt import emit, fail

STRESS_COMPONENTS = {
    "vonMises": None, "stressXX": 0, "stressYY": 1, "stressZZ": 2,
    "stressXY": 3, "stressYZ": 4, "stressXZ": 5,
}
# ccx2paraview (U, S), foamToVTK (U, p), and synthetic names accepted per field;
# "U" is requested as displacement for structural results and as velocity for
# CFD results — the requested field name decides the interpretation.
ALIASES = {
    "displacement": ["displacement", "disp", "DISP", "U"],
    "stress": ["stress", "STRESS", "stress_tensor", "S"],
    "velocity": ["velocity", "U"],
    "pressure": ["pressure", "p"],
}


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


def _magnitude_rows(data):
    import numpy as np
    return np.linalg.norm(data, axis=1)


def _magnitude_at(data, idx):
    import math
    row = data[idx]
    return math.sqrt(sum(v * v for v in row)) if hasattr(row, "__len__") else float(row)


def _argmax_abs(data):
    import numpy as np
    mags = np.abs(data if data.ndim == 1 else np.linalg.norm(data, axis=1))
    return int(np.argmax(mags))


def main() -> None:
    parser = argparse.ArgumentParser()
    source = parser.add_mutually_exclusive_group(required=True)
    source.add_argument("--vtu")
    source.add_argument("--frd")
    parser.add_argument("--max", action="append", default=[], dest="maxima")
    parser.add_argument("--probe", action="append", default=[])
    parser.add_argument("--plot", action="append", default=[])
    parser.add_argument("--png-stem", required=True)
    parser.add_argument("--density-kg-m3", type=float, default=1.0)
    args = parser.parse_args()

    try:
        import pyvista as pv
    except ImportError as exc:
        fail(f"pyvista is not installed in this interpreter: {exc}")

    if args.vtu:
        mesh = pv.read(args.vtu)
    else:
        # pyvista/vtk ships no FRD reader; convert the frd to a sibling vtu first.
        from ccx2paraview import Converter
        Converter(args.frd, ["vtu"]).run()
        mesh = pv.read(os.path.splitext(args.frd)[0] + ".vtu")

    values = []
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

    plots = []
    for spec in args.plot:
        field = spec.split(":", 1)[0]
        scale = spec.split(":", 1)[1] if ":" in spec else None
        warp_kwargs = {"factor": float(scale)} if scale is not None else {}
        try:
            data = _find(mesh, field, args.density_kg_m3)
            scalars = data if data.ndim == 1 else _magnitude_rows(data)
            warped = mesh.warp_by_vector("displacement", **warp_kwargs) if "displacement" in mesh.point_data else mesh
            plotter = pv.Plotter(off_screen=True)
            plotter.add_mesh(warped, scalars=scalars,
                             scalar_bar_args={"title": f"{field} [{_values_unit(field)}]"})
            path = f"{args.png_stem}.{field}.png"
            plotter.screenshot(path)
            plots.append({"field": field, "path": path})
        except Exception as exc:  # noqa: BLE001 - plot failure must not kill extraction
            plots.append({"field": field, "path": None, "error": f"{type(exc).__name__}: {exc}"})

    emit({"values": values, "plots": plots})


if __name__ == "__main__":
    main()
