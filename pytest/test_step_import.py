# pytest/test_step_import.py
import json
import math

import pytest

pytest.importorskip("build123d")  # OCP 随 build123d 安装

from build123d import Box, export_step  # noqa: E402


def _imprinted_step(path):
    """raw-OCP fuse 不做 unify：一个 20×10×10 实体，大面被切成共面对（经典
    CAD 导出 imprint，10 面；UnifySameDomain 后 6 面）。"""
    from OCP.BRepAlgoAPI import BRepAlgoAPI_Fuse
    from OCP.BRepPrimAPI import BRepPrimAPI_MakeBox
    from OCP.gp import gp_Pnt
    from OCP.STEPControl import STEPControl_AsIs, STEPControl_Writer
    a = BRepPrimAPI_MakeBox(gp_Pnt(0, 0, 0), gp_Pnt(10, 10, 10)).Shape()
    b = BRepPrimAPI_MakeBox(gp_Pnt(10, 0, 0), gp_Pnt(20, 10, 10)).Shape()
    fuse = BRepAlgoAPI_Fuse(a, b)
    fuse.Build()
    writer = STEPControl_Writer()
    writer.Transfer(fuse.Shape(), STEPControl_AsIs)
    writer.Write(str(path))


def _notched_step(path):
    """20×10×10 盒子开 0.02mm 宽通槽：两片 0.2mm² sliver 墙 + 0.02mm 短边。"""
    from OCP.BRepAlgoAPI import BRepAlgoAPI_Cut
    from OCP.BRepPrimAPI import BRepPrimAPI_MakeBox
    from OCP.gp import gp_Pnt
    from OCP.STEPControl import STEPControl_AsIs, STEPControl_Writer
    big = BRepPrimAPI_MakeBox(gp_Pnt(0, 0, 0), gp_Pnt(20, 10, 10)).Shape()
    slot = BRepPrimAPI_MakeBox(gp_Pnt(9.99, 0, 4.5), gp_Pnt(10.01, 10, 5.5)).Shape()
    cut = BRepAlgoAPI_Cut(big, slot)
    cut.Build()
    writer = STEPControl_Writer()
    writer.Transfer(cut.Shape(), STEPControl_AsIs)
    writer.Write(str(path))


def test_clean_step_reports_clean(stage, workdir, parse_receipt):
    step = workdir / "clean.step"
    export_step(Box(20, 10, 10), str(step))
    proc = stage(workdir, "step_import", "--step", str(step))
    receipt = parse_receipt(proc)
    assert receipt["checks"]["clean"] is True
    assert receipt["checks"]["solidCount"] == 1
    assert receipt["checks"]["mergeableFaces"] == 0
    assert receipt["checks"]["invalidSolids"] == 0
    assert receipt["stepOut"] == str(step)  # 未修复，原样
    assert receipt["repaired"] is False
    assert len(receipt["faces"]) == 6
    top = next(e for e in receipt["faces"] if e["areaMm2"] == pytest.approx(200.0))
    n = top["normal"]
    assert math.isclose(sum(v * v for v in n), 1.0, abs_tol=1e-9)


def test_detects_split_faces_without_repair(stage, workdir, parse_receipt):
    step = workdir / "imprint.step"
    _imprinted_step(step)
    proc = stage(workdir, "step_import", "--step", str(step))
    receipt = parse_receipt(proc)
    assert receipt["checks"]["clean"] is False
    assert receipt["checks"]["mergeableFaces"] == 4
    assert receipt["checks"]["faceCount"] == 10
    assert receipt["repaired"] is False


def test_repairs_split_faces(stage, workdir, parse_receipt):
    step = workdir / "imprint.step"
    _imprinted_step(step)
    out = workdir / "imprint_clean.step"
    proc = stage(workdir, "step_import", "--step", str(step), "--repair", "--out", str(out))
    receipt = parse_receipt(proc)
    assert receipt["repaired"] is True
    assert receipt["stepOut"] == str(out)
    assert out.exists()
    assert receipt["repairedDelta"]["facesBefore"] == 10
    assert receipt["repairedDelta"]["facesAfter"] == 6
    assert receipt["checks"]["mergeableFaces"] == 0
    assert receipt["checks"]["clean"] is True


def test_detects_sliver_faces_and_short_edges(stage, workdir, parse_receipt):
    step = workdir / "notch.step"
    _notched_step(step)
    # 显式放宽阈值：0.005×200mm²=1mm² → 0.2mm² 的槽墙计入 sliver
    proc = stage(workdir, "step_import", "--step", str(step),
                 "--sliver-area-ratio", "0.005")
    receipt = parse_receipt(proc)
    assert receipt["checks"]["clean"] is False
    assert len(receipt["checks"]["sliverFaces"]) == 2
    assert receipt["checks"]["sliverFaces"][0]["areaMm2"] == pytest.approx(0.2, abs=1e-6)
    assert receipt["checks"]["shortEdges"]["count"] >= 2
    assert receipt["checks"]["shortEdges"]["minLengthMm"] == pytest.approx(0.02, abs=1e-6)


def test_name_faces_sidecar_feeds_mesh(stage, workdir, parse_receipt):
    # 端到端：导入 → 按 receipt 面清单命名两端面 → mesh.py 指纹重建物理组
    step = workdir / "beam.step"
    export_step(Box(20, 10, 10), str(step))
    faces = workdir / "beam.faces.json"
    proc = stage(workdir, "step_import", "--step", str(step), "--faces-json", str(faces))
    table = parse_receipt(proc)["faces"]
    fixed_id = min(table, key=lambda e: e["centroidMm"][0])["id"]  # x = 0 端
    load_id = max(table, key=lambda e: e["centroidMm"][0])["id"]   # x = 20 端
    proc = stage(workdir, "step_import", "--step", str(step),
                 "--name-faces", json.dumps([
                     {"faceId": fixed_id, "name": "fixed"},
                     {"faceId": load_id, "name": "load"},
                 ]), "--faces-json", str(faces))
    receipt = parse_receipt(proc)
    assert receipt["facesJsonPath"] == str(faces)
    assert {g["name"] for g in receipt["namedGroups"]} == {"fixed", "load"}
    sidecar = json.loads(faces.read_text())
    assert set(sidecar) == {"fixed", "load"}
    assert "centroidMm" in sidecar["fixed"][0] and "areaMm2" in sidecar["fixed"][0]
    msh = workdir / "beam.msh"
    proc = stage(workdir, "mesh", "--step", str(step), "--faces-json", str(faces),
                 "--msh", str(msh), "--element-size", "4.0")
    receipt = parse_receipt(proc)
    assert set(receipt["groupNames"]) >= {"fixed", "load", "solid"}


def test_name_faces_rejects_unknown_id(stage, workdir):
    step = workdir / "box.step"
    export_step(Box(20, 10, 10), str(step))
    proc = stage(workdir, "step_import", "--step", str(step),
                 "--name-faces", json.dumps([{"faceId": 99, "name": "ghost"}]))
    assert proc.returncode == 1
    assert "faceId 99" in proc.stderr


def test_name_faces_rejects_non_ascii_name(stage, workdir):
    # '固定'.isalnum() 为 True，但物理组名必须是 ASCII 字母数字/下划线
    step = workdir / "box.step"
    export_step(Box(20, 10, 10), str(step))
    proc = stage(workdir, "step_import", "--step", str(step),
                 "--name-faces", json.dumps([{"faceId": 1, "name": "固定"}]))
    assert proc.returncode == 1
    assert "alphanumeric/underscore" in proc.stderr


def test_fails_loud_on_missing_file(stage, workdir):
    proc = stage(workdir, "step_import", "--step", str(workdir / "nope.step"))
    assert proc.returncode == 1
    assert "does not exist" in proc.stderr
