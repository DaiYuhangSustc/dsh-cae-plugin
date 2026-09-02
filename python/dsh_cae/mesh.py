# python/dsh_cae/mesh.py
"""Mesh stage: STEP in, Gmsh tetra mesh out, named physical groups rebuilt by fingerprint."""
import argparse
import json
import math
import os

from dsh_cae.receipt import emit, fail


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--step", required=True)
    parser.add_argument("--faces-json")
    parser.add_argument("--msh", required=True)
    parser.add_argument("--element-size", type=float, default=2.0)
    parser.add_argument("--element-type", choices=["tet4", "tet10"], default="tet10")
    parser.add_argument("--min-size", type=float)
    parser.add_argument("--max-size", type=float)
    args = parser.parse_args()

    try:
        import gmsh
    except ImportError as exc:
        fail(f"gmsh is not installed in this interpreter: {exc}")

    sidecar = {}
    # cad.py writes the sidecar only when the script defined NAMED_FACES —
    # an absent file means "no named faces to rebuild", not an error. The TS
    # tool layer always passes --faces-json, so geometry built without named
    # faces (the common first CAD pass) lands here.
    if args.faces_json and os.path.exists(args.faces_json):
        with open(args.faces_json, encoding="utf-8") as handle:
            sidecar = json.load(handle)

    gmsh.initialize()
    try:
        gmsh.option.setNumber("General.Terminal", 0)
        gmsh.model.add("cae")
        gmsh.model.occ.importShapes(args.step)
        gmsh.model.occ.synchronize()

        surfaces = gmsh.model.getEntities(2)
        diag = _bbox_diagonal(gmsh)
        centroid_tol = 1e-6 * diag + 1e-9
        area_tol = 1e-9

        group_names: list[str] = []
        fingerprints = []
        for dim, tag in surfaces:
            cx, cy, cz = gmsh.model.occ.getCenterOfMass(2, tag)
            area = gmsh.model.occ.getMass(2, tag)
            fingerprints.append({"tag": tag, "centroid": [cx, cy, cz], "area": area})

        for name, entries in sidecar.items():
            matched: list[int] = []
            for entry in (entries if isinstance(entries, list) else [entries]):
                hits = [
                    fp["tag"] for fp in fingerprints
                    if _close(fp["centroid"], entry["centroidMm"], centroid_tol)
                    and math.isclose(fp["area"], entry["areaMm2"], rel_tol=area_tol, abs_tol=area_tol)
                ]
                if not hits:
                    fail(
                        f"face group '{name}' matched no STEP surface "
                        f"(wanted centroid {entry['centroidMm']}, area {entry['areaMm2']}); "
                        f"candidates: {json.dumps(fingerprints)}"
                    )
                matched.extend(hits)
            gmsh.model.addPhysicalGroup(2, matched, name=name)
            group_names.append(name)

        volumes = [tag for _dim, tag in gmsh.model.getEntities(3)]
        gmsh.model.addPhysicalGroup(3, volumes, name="solid")
        group_names.append("solid")

        max_size = args.max_size if args.max_size else args.element_size
        min_size = args.min_size if args.min_size else args.element_size / 5.0
        gmsh.option.setNumber("Mesh.CharacteristicLengthMin", min_size)
        gmsh.option.setNumber("Mesh.CharacteristicLengthMax", max_size)
        gmsh.option.setNumber("Mesh.ElementOrder", 2 if args.element_type == "tet10" else 1)
        gmsh.option.setNumber("Mesh.SecondOrderIncomplete", 0)
        gmsh.option.setNumber("Mesh.MshFileVersion", 4.1)
        gmsh.model.mesh.generate(3)

        node_tags, _coords, _param = gmsh.model.mesh.getNodes()
        element_count = 0
        for tag in volumes:
            _types, etags, _nodes = gmsh.model.mesh.getElements(3, tag)
            for group in etags:
                element_count += len(group)
        min_jacobian = _min_sj(gmsh)
        connectivity = _connectivity(gmsh)

        gmsh.write(args.msh)
        receipt = {
            "mshPath": args.msh,
            "nodeCount": len(node_tags),
            "elementCount": element_count,
            "groupNames": group_names,
            "quality": {"minJacobian": min_jacobian},
            "connectivity": connectivity,
        }
        if connectivity["components"] > 1:
            receipt["warnings"] = [
                f"mesh has {connectivity['components']} disconnected components "
                f"({connectivity['isolatedElements']} of {connectivity['totalElements']} "
                f"elements outside the largest one); a downstream static solve will be "
                f"singular unless every component is constrained or tied"
            ]
        emit(receipt)
    finally:
        gmsh.finalize()


def _close(a, b, tol):
    return all(abs(x - y) <= tol for x, y in zip(a, b))


def _bbox_diagonal(gmsh):
    xmin, ymin, zmin, xmax, ymax, zmax = gmsh.model.getBoundingBox(-1, -1)
    return math.dist((xmin, ymin, zmin), (xmax, ymax, zmax))


def _min_sj(gmsh):
    """Minimum scaled Jacobian over volume elements; None when the gmsh build lacks getQualities."""
    try:
        values = []
        for dim, tag in gmsh.model.getEntities(3):
            types, etags, _nodes = gmsh.model.mesh.getElements(dim, tag)
            for etype, tags in zip(types, etags):
                values.extend(gmsh.model.mesh.getQualities(tags, [etype], "minSJ")[0])
        return min(values) if values else None
    except (AttributeError, TypeError, RuntimeError):
        return None


def _connectivity(gmsh):
    """Node-sharing components among volume elements; more than one means
    floating solids and a singular downstream static solve."""
    parent: dict[int, int] = {}

    def find(x: int) -> int:
        while parent[x] != x:
            parent[x] = parent[parent[x]]  # path halving
            x = parent[x]
        return x

    reps: list[int] = []  # one node per element; rooted only after all unions
    total = 0
    for _dim, tag in gmsh.model.getEntities(3):
        types, etags, enodes = gmsh.model.mesh.getElements(3, tag)
        for etype, tags, nodes in zip(types, etags, enodes):
            width = len(nodes) // len(tags)
            corners = 4 if int(etype) == 11 else width  # tet10: 4 corners, then 6 mid-edge
            for k in range(len(tags)):
                conn = [int(n) for n in nodes[k * width:k * width + corners]]
                for n in conn:
                    parent.setdefault(n, n)
                for n in conn[1:]:
                    ra, rb = find(conn[0]), find(n)
                    if ra != rb:
                        parent[rb] = ra
                reps.append(conn[0])
                total += 1
    if total == 0:
        return {"components": 0, "totalElements": 0, "isolatedElements": 0}
    sizes: dict[int, int] = {}
    for node in reps:
        root = find(node)
        sizes[root] = sizes.get(root, 0) + 1
    return {
        "components": len(sizes),
        "totalElements": total,
        "isolatedElements": total - max(sizes.values()),
    }


if __name__ == "__main__":
    main()
