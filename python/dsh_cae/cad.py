"""CAD stage: run a build123d script, export STEP, fingerprint named faces."""
import argparse
import json

from dsh_cae.receipt import emit, fail


def _iterfaces(value):
    """Normalize a NAMED_FACES entry (single Face or iterable of Faces)."""
    try:
        iter(value)
    except TypeError:
        value = [value]
    return list(value)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--script-file", required=True)
    parser.add_argument("--step", required=True)
    parser.add_argument("--faces-json")
    args = parser.parse_args()

    try:
        from build123d import export_step
    except ImportError as exc:
        fail(f"build123d is not installed in this interpreter: {exc}")

    namespace: dict = {}
    try:
        with open(args.script_file, encoding="utf-8") as handle:
            code = compile(handle.read(), args.script_file, "exec")
        exec(code, namespace)  # noqa: S102 - model-authored script, trust level = bash tool
    except Exception as exc:  # noqa: BLE001 - script failures are domain diagnostics
        fail(f"cad script failed: {type(exc).__name__}: {exc}")

    part = namespace.get("part")
    if part is None:
        fail("cad script must define 'part' (a build123d solid/BuildPart)")

    try:
        export_step(part, args.step)
    except Exception as exc:  # noqa: BLE001
        fail(f"STEP export failed: {type(exc).__name__}: {exc}")

    bbox = part.bounding_box()
    named = []
    sidecar: dict = {}
    faces_by_name = namespace.get("NAMED_FACES", {})
    if faces_by_name:
        if not isinstance(faces_by_name, dict):
            fail("NAMED_FACES must be a dict of {name: Face or list of Faces}")
        for name, selection in faces_by_name.items():
            for face in _iterfaces(selection):
                center = face.center()
                normal = face.normal_at(center)
                entry = {
                    "centroidMm": [center.X, center.Y, center.Z],
                    "areaMm2": face.area,
                    "normal": [normal.X, normal.Y, normal.Z],
                }
                sidecar.setdefault(str(name), []).append(entry)
                named.append({"name": str(name), "areaMm2": face.area, "centroidMm": entry["centroidMm"]})
    if args.faces_json and sidecar:
        with open(args.faces_json, "w", encoding="utf-8") as handle:
            json.dump(sidecar, handle)

    emit({
        "stepPath": args.step,
        "volumeMm3": part.volume,
        "bboxMm": {
            "min": [bbox.min.X, bbox.min.Y, bbox.min.Z],
            "max": [bbox.max.X, bbox.max.Y, bbox.max.Z],
        },
        "namedFaces": named,
    })


if __name__ == "__main__":
    main()
