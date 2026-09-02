# python/dsh_cae/step_import.py
"""STEP import stage: validate external geometry (invalid solids, free edges,
sliver faces, short edges, mergeable split faces), optionally heal it (OCCT
ShapeFix + UnifySameDomain), and fingerprint AI-named faces onto a sidecar in
cad.py's format so mesh.py can rebuild boundary-condition groups. Issues are
reports in the receipt; only unreadable files, solids-free geometry, or bad
nameFaces ids fail."""
import argparse
import json
import math
import os

from dsh_cae.receipt import emit, fail


def _load_step(path: str):
    from OCP.IFSelect import IFSelect_RetDone
    from OCP.STEPControl import STEPControl_Reader
    if not os.path.isfile(path):
        fail(f"STEP file '{path}' does not exist")
    reader = STEPControl_Reader()
    if reader.ReadFile(path) != IFSelect_RetDone:
        fail(f"cannot read STEP file '{path}' (parser rejected it)")
    reader.TransferRoots()
    return reader.OneShape()


def _subshapes(shape, kind):
    from OCP.TopExp import TopExp_Explorer
    shapes, exp = [], TopExp_Explorer(shape, kind)
    while exp.More():
        shapes.append(exp.Current())
        exp.Next()
    return shapes


def _unique_edges(shape):
    from OCP.TopAbs import TopAbs_EDGE
    from OCP.TopExp import TopExp
    from OCP.TopTools import TopTools_IndexedMapOfShape
    m = TopTools_IndexedMapOfShape()
    TopExp.MapShapes_s(shape, TopAbs_EDGE, m)
    return [m.FindKey(i + 1) for i in range(m.Extent())]


def _face_entries(shape):
    """Per-face receipt rows: id (explorer order, deterministic), area,
    centroid, outward unit normal at the parametric center."""
    from OCP.BRepAdaptor import BRepAdaptor_Surface
    from OCP.BRepGProp import BRepGProp
    from OCP.GProp import GProp_GProps
    from OCP.TopoDS import TopoDS
    from OCP.gp import gp_Pnt, gp_Vec
    from OCP.TopAbs import TopAbs_FACE, TopAbs_REVERSED
    entries = []
    for i, raw in enumerate(_subshapes(shape, TopAbs_FACE)):
        face = TopoDS.Face_s(raw)
        props = GProp_GProps()
        BRepGProp.SurfaceProperties_s(face, props)
        surf = BRepAdaptor_Surface(face)
        point, du, dv = gp_Pnt(), gp_Vec(), gp_Vec()
        umid = (surf.FirstUParameter() + surf.LastUParameter()) / 2
        vmid = (surf.FirstVParameter() + surf.LastVParameter()) / 2
        surf.D1(umid, vmid, point, du, dv)
        cross = du.Crossed(dv)
        mag = math.sqrt(cross.X() ** 2 + cross.Y() ** 2 + cross.Z() ** 2)
        normal = [cross.X() / mag, cross.Y() / mag, cross.Z() / mag] if mag > 0 else [0.0, 0.0, 0.0]
        if face.Orientation() == TopAbs_REVERSED:
            normal = [-v for v in normal]
        center = props.CentreOfMass()
        entries.append({
            "id": i + 1,
            "areaMm2": props.Mass(),
            "centroidMm": [center.X(), center.Y(), center.Z()],
            "normal": normal,
        })
    return entries


def _inspect(shape, sliver_ratio: float, short_ratio: float):
    """All dirty-geometry signals plus the face table; fails loud when the
    shape holds no solid. Returns (summary, entries)."""
    from OCP.BRepBndLib import BRepBndLib
    from OCP.BRepCheck import BRepCheck_Analyzer
    from OCP.BRepGProp import BRepGProp
    from OCP.Bnd import Bnd_Box
    from OCP.GProp import GProp_GProps
    from OCP.ShapeAnalysis import ShapeAnalysis_Shell
    from OCP.ShapeUpgrade import ShapeUpgrade_UnifySameDomain
    from OCP.TopAbs import TopAbs_FACE, TopAbs_SOLID

    solids = _subshapes(shape, TopAbs_SOLID)
    if not solids:
        fail("STEP contains no solid bodies — geometry must be a solid or compound of solids")
    entries = _face_entries(shape)
    bbox = Bnd_Box()
    BRepBndLib.Add_s(shape, bbox)
    xmin, ymin, zmin, xmax, ymax, zmax = bbox.Get()
    diag = math.dist((xmin, ymin, zmin), (xmax, ymax, zmax))

    lengths = []
    for edge in _unique_edges(shape):
        props = GProp_GProps()
        BRepGProp.LinearProperties_s(edge, props)
        lengths.append(props.Mass())

    shells = ShapeAnalysis_Shell()
    shells.LoadShells(shape)
    shells.CheckOrientedShells(shape, True)

    # Mergeable = faces a same-domain unify would stitch away (imprint seams).
    unified = ShapeUpgrade_UnifySameDomain(shape, True, True, False)
    unified.Build()
    mergeable = len(entries) - len(_subshapes(unified.Shape(), TopAbs_FACE))

    sliver_threshold = sliver_ratio * max(e["areaMm2"] for e in entries)
    short_threshold = short_ratio * diag
    summary = {
        "solidCount": len(solids),
        "faceCount": len(entries),
        "invalidSolids": sum(1 for s in solids if not BRepCheck_Analyzer(s).IsValid()),
        "freeEdges": bool(shells.HasFreeEdges()),
        "sliverFaces": [{"id": e["id"], "areaMm2": e["areaMm2"]} for e in entries
                        if e["areaMm2"] < sliver_threshold],
        "shortEdges": {
            "count": sum(1 for l in lengths if l < short_threshold),
            "minLengthMm": min(lengths) if lengths else None,
            "thresholdMm": short_threshold,
        },
        "mergeableFaces": mergeable,
    }
    summary["clean"] = not (summary["invalidSolids"] or summary["freeEdges"]
                            or summary["sliverFaces"] or summary["shortEdges"]["count"]
                            or summary["mergeableFaces"])
    return summary, entries


def _heal(shape):
    from OCP.ShapeFix import ShapeFix_Shape
    from OCP.ShapeUpgrade import ShapeUpgrade_UnifySameDomain
    fixer = ShapeFix_Shape(shape)
    fixer.Perform()
    unified = ShapeUpgrade_UnifySameDomain(fixer.Shape(), True, True, False)
    unified.Build()
    return unified.Shape()


def _write_step(shape, path: str) -> None:
    from OCP.IFSelect import IFSelect_RetDone
    from OCP.STEPControl import STEPControl_AsIs, STEPControl_Writer
    writer = STEPControl_Writer()
    if writer.Transfer(shape, STEPControl_AsIs) != IFSelect_RetDone:
        fail("STEP transfer failed while writing the healed geometry")
    if writer.Write(path) != IFSelect_RetDone:
        fail(f"cannot write STEP file '{path}'")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--step", required=True)
    parser.add_argument("--out")
    parser.add_argument("--repair", action="store_true")
    parser.add_argument("--name-faces", help="JSON [{faceId, name}]")
    parser.add_argument("--faces-json")
    parser.add_argument("--sliver-area-ratio", type=float, default=1e-4)
    parser.add_argument("--short-edge-ratio", type=float, default=1e-3)
    args = parser.parse_args()

    try:
        import OCP  # noqa: F401
    except ImportError as exc:
        fail(f"OCP is not installed in this interpreter (ships with build123d): {exc}")

    shape = _load_step(args.step)
    before, _entries = _inspect(shape, args.sliver_area_ratio, args.short_edge_ratio)

    out_path = args.step
    repaired_delta = None
    if args.repair:
        healed = _heal(shape)
        after, entries = _inspect(healed, args.sliver_area_ratio, args.short_edge_ratio)
        repaired_delta = {
            "facesBefore": before["faceCount"],
            "facesAfter": after["faceCount"],
            "mergeableFacesRemaining": after["mergeableFaces"],
        }
        out_path = args.out or (os.path.splitext(args.step)[0] + "_clean.step")
        _write_step(healed, out_path)
        shape, summary = healed, after
    else:
        summary, entries = before, _entries

    named_groups: list = []
    faces_json_path = None
    if args.name_faces:
        mapping = json.loads(args.name_faces)
        by_id = {e["id"]: e for e in entries}
        names: dict = {}
        for item in mapping:
            fid, name = int(item["faceId"]), str(item["name"])
            if fid not in by_id:
                fail(f"nameFaces references faceId {fid}, but the output geometry "
                     f"has faces 1..{len(entries)}")
            if not name or not name.isascii() or not name.replace("_", "a").isalnum():
                fail(f"face name '{name}' must be alphanumeric/underscore")
            if name in names:
                fail(f"nameFaces reuses name '{name}'; names must be unique")
            names.setdefault(name, []).append(by_id[fid])
        named_groups = [{"name": n, "faceIds": [e["id"] for e in es]} for n, es in names.items()]
        if args.faces_json:
            sidecar = {n: [{"centroidMm": e["centroidMm"], "areaMm2": e["areaMm2"],
                            "normal": e["normal"]} for e in es]
                       for n, es in names.items()}
            with open(args.faces_json, "w", encoding="utf-8") as handle:
                json.dump(sidecar, handle)
            faces_json_path = args.faces_json

    emit({
        "stepPath": args.step,
        "stepOut": out_path,
        "repaired": bool(args.repair),
        "repairedDelta": repaired_delta,
        "checks": summary,
        "faces": entries,
        "namedGroups": named_groups,
        "facesJsonPath": faces_json_path,
    })


if __name__ == "__main__":
    main()
