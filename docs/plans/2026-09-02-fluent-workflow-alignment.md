# 六阶段工作流对齐（v0.4.0）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 补齐 Fluent 六阶段工作流缺口 —— 外部 STEP 导入校验/修复（`cae_step_import`）、CFD 瞬态分支（`cae_cfd_transient`）、网格无关性自动化（`cae_verify_mesh`），工具从 6 个变 9 个。

**Architecture:** Python 阶段进程一如既往单发子进程 + stdout receipt（`<<<DSH_CAE_JSON>>>`）。STEP 导入用 OCP（随 build123d 安装）做 OCCT 校验/愈合，命名面以 cad.py 同格式指纹 sidecar 落盘，mesh.py 零改动。瞬态复用 cfd_case.py 的 case 骨架，新增 Euler schemes + PIMPLE + 真实时间 controlDict。网格无关性是纯 TS 宏工具：循环调现有 mesh/solve/cfd_mesh/cfd_steady/post 五个 stage，GCI 数学（Celik 2008）独立成 `src/gci.ts` 纯函数。

**Tech Stack:** TypeScript（@deepseek-ai/dsh-tools、vitest）、Python（OCP/OCCT、OpenFOAM 13 foamRun、pytest）。

**Spec:** `docs/specs/2026-09-02-fluent-workflow-alignment-design.md`

## Global Constraints

- **零新依赖**：不加任何 pip/conda/npm 包。OCP 随 build123d 已在镜像；GCI 是纯 TS。
- **TS↔Python 契约**：argv + stdout receipt 标记 `<<<DSH_CAE_JSON>>>`，仅此而已。域失败 = receipt（exit 0），基础设施失败 = 非零退出/无 receipt。
- **提交规范：commit message 一律不加 `Co-Authored-By` 尾注**（仓库铁律，贡献者只有 daiyuhang）。
- Python 测试命令（pytest/ 目录会遮蔽包，绝不能 `python -m pytest`）：
  `LD_LIBRARY_PATH="$HOME/miniconda3/envs/dsh-cae/lib" ~/miniconda3/envs/dsh-cae/bin/pytest pytest/<file> -v`（在仓库根执行）
- TS 测试命令：`pnpm vitest run tests/<file>`；类型检查：`pnpm build`。
- 单位：结构链 mm / MPa / N；CFD 链 SI（m/s / Pa / kg/m³）。
- OpenFOAM 相关 pytest 在无 OpenFOAM 环境自跳过（`cfd_case.try_resolve_bashrc()` 模式）。
- 新 stage 名 = `python/dsh_cae/` 下模块名（`step_import`、`cfd_transient`），`runStage(config, '<module>', ...)` 直接可用，无需注册表。

## File Structure

| 文件 | 职责 |
| --- | --- |
| Create `python/dsh_cae/step_import.py` | STEP 校验 + 可选愈合 + 面清单 + 命名面 sidecar |
| Create `pytest/test_step_import.py` | step_import 阶段测试（真实 OCP，无 solver 依赖） |
| Create `src/tools/step-import.ts` | `cae_step_import` 工具（TS 层） |
| Create `tests/tools-step-import.test.ts` | argv/校验测试（mock runStage） |
| Modify `python/dsh_cae/cfd_case.py` | +`FV_SCHEMES_TRANSIENT`、`FV_SOLUTION_TRANSIENT`、`write_control_dict_transient`、`parse_transient_log` |
| Create `python/dsh_cae/cfd_transient.py` | 瞬态求解阶段 |
| Modify `pytest/test_cfd_case.py` | +`parse_transient_log` 纯解析测试 |
| Create `pytest/test_cfd_transient.py` | 瞬态真实 foamRun 测试（无 OpenFOAM 自跳过） |
| Create `src/tools/cfd-transient.ts` | `cae_cfd_transient` 工具 |
| Create `tests/tools-cfd-transient.test.ts` | 校验/argv/bashrc-drop 测试 |
| Create `src/gci.ts` | GCI 纯数学（Celik 2008） |
| Create `tests/gci.test.ts` | 解析序列回归 |
| Create `src/tools/verify-mesh.ts` | `cae_verify_mesh` 宏工具 |
| Create `tests/verify-mesh.test.ts` | 循环/失败传播/GCI 集成测试（mock runStage） |
| Modify `src/index.ts` | 注册三个新工具（分三步，各自任务内） |
| Modify `README.md` / `README.zh.md` | 工具表 + 六阶段映射 + 阶段6人工说明 |
| Modify `package.json` | version → 0.4.0 |

---

### Task 1: `step_import` Python 阶段

**Files:**
- Create: `python/dsh_cae/step_import.py`
- Test: `pytest/test_step_import.py`

**Interfaces:**
- Consumes: `dsh_cae.receipt.emit/fail`（现有）；OCP（随 build123d）。
- Produces: stage `step_import`，CLI：`--step --out --repair --name-faces --faces-json --sliver-area-ratio --short-edge-ratio`。receipt 字段见 Task 2 的 `StepImportReceipt`（TS 接口与之逐字段对应）。faces.json sidecar 格式与 cad.py 完全一致：`{name: [{centroidMm, areaMm2, normal}]}`。

已用本机 OCP 实测的 API 事实（照抄，勿改）：
- 面积/质心：`BRepGProp.SurfaceProperties_s(face, props)` → `props.Mass()`、`props.CentreOfMass()`（**没有** `FaceProperties_s`）
- 边长：`BRepGProp.LinearProperties_s(edge, props)` → `props.Mass()`
- 法向：`BRepAdaptor_Surface(face).D1(umid, vmid, P, D1U, D1V)`，normal = `D1U.Crossed(D1V)` 归一化，`face.Orientation() == TopAbs_REVERSED` 时取反
- 遍历器返回 `TopoDS_Shape`，面要 `TopoDS.Face_s(raw)` 转 `TopoDS_Face`
- 读写 STEP：`STEPControl_Reader.ReadFile/TransferRoots/OneShape`、`STEPControl_Writer.Transfer/Write`，状态都对 `IFSelect_RetDone`
- 脏几何 fixture（raw OCP，不经 build123d 清理）见测试代码

- [ ] **Step 1: 写失败测试**

```python
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
    assert receipt["faces"][0]["areaMm2"] == pytest.approx(200.0)
    n = receipt["faces"][0]["normal"]
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


def test_fails_loud_on_missing_file(stage, workdir):
    proc = stage(workdir, "step_import", "--step", str(workdir / "nope.step"))
    assert proc.returncode == 1
    assert "does not exist" in proc.stderr
```

- [ ] **Step 2: 跑测试确认失败**

Run: `LD_LIBRARY_PATH="$HOME/miniconda3/envs/dsh-cae/lib" ~/miniconda3/envs/dsh-cae/bin/pytest pytest/test_step_import.py -v`
Expected: 全部 ERROR/FAIL（`No module named 'dsh_cae.step_import'`）

- [ ] **Step 3: 写实现**

```python
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
```

```python
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
            if not name or not name.replace("_", "a").isalnum():
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
```

注意 `summary, entries = before, _entries` 分支：非修复路径 `entries` 就是 `_inspect` 返回的那份（`_entries`），不需要再算。

- [ ] **Step 4: 跑测试确认通过**

Run: `LD_LIBRARY_PATH="$HOME/miniconda3/envs/dsh-cae/lib" ~/miniconda3/envs/dsh-cae/bin/pytest pytest/test_step_import.py -v`
Expected: 7 passed

- [ ] **Step 5: 全量 Python 回归**

Run: `LD_LIBRARY_PATH="$HOME/miniconda3/envs/dsh-cae/lib" ~/miniconda3/envs/dsh-cae/bin/pytest pytest -v`
Expected: 既有 51 passed + 新 7 = 58 passed（无 OpenFOAM 时 CFD 文件跳过，数目按环境）

- [ ] **Step 6: Commit**

```bash
git add python/dsh_cae/step_import.py pytest/test_step_import.py
git commit -m "feat: step_import stage — external STEP validation, OCCT healing, named-face sidecar"
```

（不加任何 Co-Authored-By 尾注。）

---

### Task 2: `cae_step_import` TS 工具

**Files:**
- Create: `src/tools/step-import.ts`
- Create: `tests/tools-step-import.test.ts`
- Modify: `src/index.ts`

**Interfaces:**
- Consumes: `runStage(config, 'step_import', argv, {signal, logFile})`（Task 1 的 stage）；`ensureDeps(config, signal, 'structural')`。
- Produces: `defineCaeStepImportTool(config)`，注册名 `cae_step_import`；`StepImportReceipt` 导出接口（字段与 Task 1 receipt 逐一对齐）。

- [ ] **Step 1: 写失败测试**

```typescript
// tests/tools-step-import.test.ts
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import { defineCaeStepImportTool } from '../src/tools/step-import.ts'

vi.mock('../src/runner.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/runner.js')>()
  return { ...actual, ensureDeps: vi.fn(), runStage: vi.fn() }
})

const config = { python: 'python3', workdir: './cae-stub', stageTimeoutMs: 1000 } as const
const exec = () => ({ signal: new AbortController().signal }) as ToolRunContext

const runnerMod = async () => import('../src/runner.js')

const workdirs: string[] = []
const workdir = async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-cae-stepimport-'))
  workdirs.push(dir)
  return dir
}
afterAll(async () => {
  await Promise.all(workdirs.map(d => rm(d, { recursive: true, force: true })))
})

beforeEach(async () => {
  const runner = await runnerMod()
  vi.mocked(runner.runStage).mockReset()
  vi.mocked(runner.runStage).mockResolvedValue({ receipt: { stepOut: '/x.step' }, logPath: '/tmp/stub.log' })
  vi.mocked(runner.ensureDeps).mockResolvedValue(undefined)
})

describe('cae_step_import argv construction', () => {
  it('resolves the step path and omits repair by default', async () => {
    const tool = defineCaeStepImportTool({ ...config, workdir: await workdir() })
    await tool.execute({ step: './bracket.step' }, exec())
    const runner = await runnerMod()
    const call = vi.mocked(runner.runStage).mock.calls.find(([, stage]) => stage === 'step_import')
    expect(call).toBeDefined()
    const argv = call![2]
    expect(argv[argv.indexOf('--step') + 1]).toBe(resolve('./bracket.step'))
    expect(argv).not.toContain('--repair')
    expect(argv).toContain('--faces-json')
  })

  it('forwards repair and nameFaces as stage flags', async () => {
    const tool = defineCaeStepImportTool({ ...config, workdir: await workdir() })
    const facesJson = '/tmp/bracket.faces.json'
    await tool.execute({
      step: '/tmp/bracket.step', repair: true, facesJson,
      nameFaces: [{ faceId: 2, name: 'fixed' }, { faceId: 3, name: 'load' }],
    }, exec())
    const runner = await runnerMod()
    const argv = vi.mocked(runner.runStage).mock.calls[0]![2]
    expect(argv).toContain('--repair')
    const nf = argv[argv.indexOf('--name-faces') + 1]
    expect(JSON.parse(nf)).toEqual([{ faceId: 2, name: 'fixed' }, { faceId: 3, name: 'load' }])
    expect(argv[argv.indexOf('--faces-json') + 1]).toBe(facesJson)
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm vitest run tests/tools-step-import.test.ts`
Expected: FAIL（模块 `../src/tools/step-import.ts` 不存在）

- [ ] **Step 3: 写实现**

```typescript
// src/tools/step-import.ts
import { resolve } from 'node:path'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { ensureDeps, runStage } from '../runner.js'
import type { Config } from '../config.js'

const DESCRIPTION =
  'Import an external STEP file (mm): validate the geometry (invalid solids, free edges, '
  + 'sliver faces, short edges, mergeable split faces) and optionally heal it (OCCT ShapeFix '
  + '+ same-domain merge; healed geometry is written to a new *_clean.step). Recommended flow: '
  + 'call WITHOUT nameFaces first and read the faces table (id, areaMm2, centroidMm, normal), '
  + 'decide which faces carry boundary conditions, then call again with nameFaces '
  + '[{faceId, name}] — with the SAME repair setting as the first call — to write the '
  + 'faces.json sidecar that cae_mesh_generate rebuilds into named groups for '
  + 'cae_solve_static. clean=false issues are reports, not errors; heal them by re-calling '
  + 'with repair=true. Only unreadable files, solids-free geometry, or bad faceIds fail.'

/** Receipt shape of the `step_import` stage, pinned for the tool's output schema. */
export interface StepImportReceipt {
  stepPath: string
  stepOut: string
  repaired: boolean
  repairedDelta: { facesBefore: number; facesAfter: number; mergeableFacesRemaining: number } | null
  checks: {
    solidCount: number
    faceCount: number
    invalidSolids: number
    freeEdges: boolean
    sliverFaces: { id: number; areaMm2: number }[]
    shortEdges: { count: number; minLengthMm: number | null; thresholdMm: number }
    mergeableFaces: number
    clean: boolean
  }
  faces: { id: number; areaMm2: number; centroidMm: number[]; normal: number[] }[]
  namedGroups: { name: string; faceIds: number[] }[]
  facesJsonPath: string | null
}

/** Build the `cae_step_import` tool bound to one deployment configuration. */
export function defineCaeStepImportTool(config: Config) {
  return defineTool({
    name: 'cae_step_import',
    description: DESCRIPTION,
    parameters: {
      step: { type: 'string', required: true, description: 'Path to the .step file to import (mm).' },
      repair: { type: 'boolean', description: 'Heal the geometry (ShapeFix + merge split faces) into a new *_clean.step. Default false.' },
      nameFaces: {
        type: 'array',
        items: {
          type: 'object', additionalProperties: false,
          properties: {
            faceId: { type: 'integer', required: true },
            name: { type: 'string', required: true, description: 'Alphanumeric/underscore group name, e.g. "fixed".' },
          },
          required: ['faceId', 'name'],
        },
        description: 'Face names assigned by faceId from the receipt table; writes the faces.json sidecar.',
      },
      facesJson: { type: 'string', description: 'Sidecar path for nameFaces; pass it as facesJson to cae_mesh_generate. Default <step stem>.faces.json.' },
    },
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        properties: {
          stepPath: { type: 'string', required: true },
          stepOut: { type: 'string', required: true },
          repaired: { type: 'boolean', required: true },
          repairedDelta: {
            oneOf: [{
              type: 'object', additionalProperties: false,
              properties: {
                facesBefore: { type: 'integer', required: true },
                facesAfter: { type: 'integer', required: true },
                mergeableFacesRemaining: { type: 'integer', required: true },
              },
            }, { type: 'null' }], required: true,
          },
          checks: {
            type: 'object', additionalProperties: false, required: true,
            properties: {
              solidCount: { type: 'integer', required: true },
              faceCount: { type: 'integer', required: true },
              invalidSolids: { type: 'integer', required: true },
              freeEdges: { type: 'boolean', required: true },
              sliverFaces: {
                type: 'array', required: true,
                items: { type: 'object', additionalProperties: false, properties: {
                  id: { type: 'integer', required: true }, areaMm2: { type: 'number', required: true },
                } },
              },
              shortEdges: {
                type: 'object', additionalProperties: false, required: true,
                properties: {
                  count: { type: 'integer', required: true },
                  minLengthMm: { oneOf: [{ type: 'number' }, { type: 'null' }], required: true },
                  thresholdMm: { type: 'number', required: true },
                },
              },
              mergeableFaces: { type: 'integer', required: true },
              clean: { type: 'boolean', required: true },
            },
          },
          faces: {
            type: 'array', required: true,
            items: { type: 'object', additionalProperties: false, properties: {
              id: { type: 'integer', required: true },
              areaMm2: { type: 'number', required: true },
              centroidMm: { type: 'array', items: { type: 'number' }, required: true },
              normal: { type: 'array', items: { type: 'number' }, required: true },
            } },
          },
          namedGroups: {
            type: 'array', required: true,
            items: { type: 'object', additionalProperties: false, properties: {
              name: { type: 'string', required: true },
              faceIds: { type: 'array', items: { type: 'integer' }, required: true },
            } },
          },
          facesJsonPath: { oneOf: [{ type: 'string' }, { type: 'null' }], required: true },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: `STEP import ${value.repaired ? '(repaired) ' : ''}${value.checks.clean ? 'clean' : 'dirty'}: `
          + `${value.checks.solidCount} solid(s), ${value.checks.faceCount} faces`
          + (value.checks.mergeableFaces ? `, ${value.checks.mergeableFaces} mergeable split faces` : '')
          + (value.checks.sliverFaces.length ? `, ${value.checks.sliverFaces.length} sliver faces` : '')
          + (value.checks.shortEdges.count ? `, ${value.checks.shortEdges.count} short edges` : '')
          + `. Geometry: ${value.stepOut}`,
      }],
    },
    async execute(args, exec) {
      const stepAbs = resolve(args.step)
      const facesJson = args.facesJson ?? stepAbs.replace(/\.step$/i, '') + '.faces.json'
      await ensureDeps(config, exec.signal, 'structural')
      const argv = ['--step', stepAbs]
      if (args.repair) argv.push('--repair')
      if (args.nameFaces?.length) {
        argv.push('--name-faces', JSON.stringify(args.nameFaces.map(f => ({ faceId: f.faceId, name: f.name }))))
      }
      argv.push('--faces-json', facesJson)
      const { receipt } = await runStage(config, 'step_import', argv,
        { signal: exec.signal, logFile: 'step_import.log' })
      return receipt as unknown as StepImportReceipt
    },
    presentCall: args => ({ card: 'terminal', title: `STEP import${args.repair ? ' + repair' : ''}`, description: 'External geometry check' }),
  })
}
```

- [ ] **Step 4: 注册到 index.ts**

`src/index.ts` 顶部 import 区加：

```typescript
import { defineCaeStepImportTool } from './tools/step-import.js'
```

`apply()` 里注册（放 `defineCaeCadTool` 之前，几何入口排最前）：

```typescript
  ctx.tools.register(defineCaeStepImportTool(config))
```

文件头注释 `Registers six stage tools` 改为 `Registers nine stage tools`。

- [ ] **Step 5: 跑测试确认通过 + 编译**

Run: `pnpm vitest run tests/tools-step-import.test.ts && pnpm build`
Expected: 2 passed；tsc 无错误

- [ ] **Step 6: Commit**

```bash
git add src/tools/step-import.ts tests/tools-step-import.test.ts src/index.ts
git commit -m "feat: cae_step_import tool — external STEP entry for the structural chain"
```

---

### Task 3: 瞬态 Python 阶段（cfd_case + cfd_transient）

**Files:**
- Modify: `python/dsh_cae/cfd_case.py`（文件末尾追加四个成员）
- Create: `python/dsh_cae/cfd_transient.py`
- Modify: `pytest/test_cfd_case.py`（追加纯解析测试）
- Test: `pytest/test_cfd_transient.py`

**Interfaces:**
- Consumes: `cfd_case.foam_run / resolve_bashrc / write_fields / apply_overrides / parse_foam_log / find_latest_vtk / tail40`（现有）；`_foam_header`（模块内已有）。
- Produces: `cfd_case.FV_SCHEMES_TRANSIENT`、`cfd_case.FV_SOLUTION_TRANSIENT`、`cfd_case.write_control_dict_transient(case_dir, end_time_s, delta_t_s, max_co, write_interval_s)`、`cfd_case.parse_transient_log(text) -> {timeStepsRun, simTimeS, maxCourantSeen}`；stage `cfd_transient`，CLI：`--case-dir --velocity --nu --rho --end-time-s --write-interval-s --max-co --delta-t --overrides-file --case --bashrc --timeout-s`。

- [ ] **Step 1: 写失败的纯解析测试（追加到 `pytest/test_cfd_case.py` 末尾）**

```python
def test_parse_transient_log_counts_steps_time_and_courant():
    log = "\n".join([
        "Courant Number mean: 0.213448 max: 0.419715",
        "deltaT 0.000408591",
        "smoothSolver:  Solving for Ux, Initial residual = 0.001, Final residual = 1e-07, No Iterations 1",
        "Time = 0.00122654",
        "Courant Number mean: 0.213481 max: 0.419794",
        "Time = 0.00163513",
        "Courant Number mean: 0.220000 max: 0.500000",
        "Time = 0.00204",
    ])
    parsed = cfd_case.parse_transient_log(log)
    assert parsed["timeStepsRun"] == 3
    assert parsed["simTimeS"] == pytest.approx(0.00204)
    assert parsed["maxCourantSeen"] == pytest.approx(0.5)
    assert cfd_case.parse_transient_log("") == {"timeStepsRun": 0, "simTimeS": 0.0, "maxCourantSeen": None}


def test_write_control_dict_transient_adaptive_and_fixed(tmp_path):
    import pathlib
    d = pathlib.Path(tmp_path)
    cfd_case.write_control_dict_transient(d, 2.0, None, 0.5, 0.1)
    text = (d / "system" / "controlDict").read_text()
    assert "endTime         2;" in text
    assert "adjustTimeStep  yes;" in text
    assert "maxCo           0.5;" in text
    assert "maxDeltaT       0.1;" in text
    assert "writeControl    adjustableRunTime;" in text
    assert "writeInterval   0.1;" in text
    cfd_case.write_control_dict_transient(d, 2.0, 0.001, None, 0.1)
    text = (d / "system" / "controlDict").read_text()
    assert "adjustTimeStep  no;" in text
    assert "deltaT          0.001;" in text
    assert "maxCo" not in text
```

（文件里已有的 `import pytest`、`from dsh_cae import cfd_case` 直接复用；若 `import pathlib` 已在文件头，局部 import 可去。）

- [ ] **Step 2: 跑测试确认失败**

Run: `LD_LIBRARY_PATH="$HOME/miniconda3/envs/dsh-cae/lib" ~/miniconda3/envs/dsh-cae/bin/pytest pytest/test_cfd_case.py -v -k transient`
Expected: FAIL（`parse_transient_log` 不存在）

- [ ] **Step 3: cfd_case.py 追加实现（文件末尾）**

```python
FV_SCHEMES_TRANSIENT = _foam_header("dictionary", "fvSchemes", "system") + """
ddtSchemes
{
    default         Euler;
}

gradSchemes
{
    default         Gauss linear;
}

divSchemes
{
    default         none;
    div(phi,U)      bounded Gauss linearUpwind grad(U);
    div((nuEff*dev2(T(grad(U))))) Gauss linear;
}

laplacianSchemes
{
    default         Gauss linear corrected;
}

interpolationSchemes
{
    default         linear;
}

snGradSchemes
{
    default         corrected;
}
"""

FV_SOLUTION_TRANSIENT = _foam_header("dictionary", "fvSolution", "system") + """
solvers
{
    p
    {
        solver          GAMG;
        tolerance       1e-06;
        relTol          0.1;
        smoother        GaussSeidel;
    }

    pFinal
    {
        $p;
        relTol          0;
    }

    U
    {
        solver          smoothSolver;
        smoother        symGaussSeidel;
        tolerance       1e-05;
        relTol          0.1;
    }

    UFinal
    {
        $U;
        relTol          0;
    }
}

PIMPLE
{
    momentumPredictor   yes;
    nOuterCorrectors    1;
    nCorrectors         2;
    nNonOrthogonalCorrectors 1;
}
"""


def write_control_dict_transient(case_dir: pathlib.Path, end_time_s: float,
                                 delta_t_s: float | None, max_co: float,
                                 write_interval_s: float) -> None:
    """Transient controlDict: real physical seconds; Courant-limited adaptive
    deltaT unless a fixed deltaT is given. purgeWrite 0 keeps history."""
    if delta_t_s is not None:
        stepping = f"adjustTimeStep  no;\ndeltaT          {delta_t_s:.6g};"
    else:
        stepping = ("adjustTimeStep  yes;\ndeltaT          1e-05;\n"
                    f"maxCo           {max_co:.6g};\nmaxDeltaT       {write_interval_s:.6g};")
    (case_dir / "system").mkdir(parents=True, exist_ok=True)
    (case_dir / "system" / "controlDict").write_text(
        _foam_header("dictionary", "controlDict", "system")
        + f"""
solver          incompressibleFluid;

startFrom       startTime;
startTime       0;
stopAt          endTime;
endTime         {end_time_s:.6g};
{stepping}

writeControl    adjustableRunTime;
writeInterval   {write_interval_s:.6g};

purgeWrite      0;
writeFormat     ascii;
writePrecision  6;
writeCompression off;
timeFormat      general;
timePrecision   6;
runTimeModifiable true;
""")


def parse_transient_log(text: str) -> dict:
    """Time-step count, final simulated seconds, and the max Courant number
    seen (transient foamRun logs carry 'Courant Number mean: x max: y')."""
    times = re.findall(r"^Time = ([0-9.eE+-]+)", text, re.M)
    cours = [float(m) for m in
             re.findall(r"Courant Number mean: [0-9.eE+-]+ max: ([0-9.eE+-]+)", text)]
    return {
        "timeStepsRun": len(times),
        "simTimeS": float(times[-1]) if times else 0.0,
        "maxCourantSeen": max(cours) if cours else None,
    }
```

- [ ] **Step 4: 跑解析测试确认通过**

Run: `LD_LIBRARY_PATH="$HOME/miniconda3/envs/dsh-cae/lib" ~/miniconda3/envs/dsh-cae/bin/pytest pytest/test_cfd_case.py -v`
Expected: 全部 passed（含新 2 条）

- [ ] **Step 5: 写 cfd_transient 阶段的失败测试**

```python
# pytest/test_cfd_transient.py
"""cfd_transient stage against real foamRun; skips without OpenFOAM."""
import pytest

from dsh_cae import cfd_case

BASHRC = cfd_case.try_resolve_bashrc()
if BASHRC is None:
    pytest.skip("no OpenFOAM bashrc resolvable", allow_module_level=True)


def _case(stage, workdir, parse_receipt, name):
    proc = stage(workdir, "cfd_mesh", "--workdir", str(workdir), "--name", name,
                 "--length-mm", "100", "--width-mm", "20", "--height-mm", "20",
                 "--cell-size-mm", "10", "--bashrc", BASHRC, "--timeout-s", "120")
    return parse_receipt(proc)["caseDir"]


def test_transient_marches_physical_time(stage, workdir, parse_receipt):
    case_dir = _case(stage, workdir, parse_receipt, "t1")
    proc = stage(workdir, "cfd_transient", "--case-dir", case_dir,
                 "--velocity", "0.02,0,0", "--nu", "1e-6", "--rho", "1000",
                 "--end-time-s", "0.05", "--write-interval-s", "0.05",
                 "--max-co", "0.5", "--bashrc", BASHRC, "--timeout-s", "300")
    receipt = parse_receipt(proc)
    assert proc.returncode == 0
    assert receipt["exitCode"] == 0
    assert receipt["timeStepsRun"] > 0
    assert receipt["simTimeS"] == pytest.approx(0.05, abs=1e-6)
    assert receipt["endTimeS"] == 0.05
    assert receipt["maxCourantSeen"] is not None and receipt["maxCourantSeen"] <= 0.6
    assert receipt["vtkPath"] and receipt["vtkPath"].endswith(".vtk")
    assert receipt["densityKgM3"] == 1000.0


def test_transient_fixed_delta_t(stage, workdir, parse_receipt):
    case_dir = _case(stage, workdir, parse_receipt, "t2")
    proc = stage(workdir, "cfd_transient", "--case-dir", case_dir,
                 "--velocity", "0.02,0,0", "--nu", "1e-6",
                 "--end-time-s", "0.02", "--write-interval-s", "0.02",
                 "--delta-t", "0.001", "--bashrc", BASHRC, "--timeout-s", "300")
    receipt = parse_receipt(proc)
    assert receipt["exitCode"] == 0
    assert receipt["timeStepsRun"] == 20  # 0.02 / 0.001, adjustableRunTime snaps exactly
    assert receipt["simTimeS"] == pytest.approx(0.02, abs=1e-9)


def test_transient_rejects_bad_args(stage, workdir):
    case_dir = str(workdir / "cfd" / "t3")
    for extra in (["--end-time-s", "0"], ["--end-time-s", "0.1", "--write-interval-s", "0.2"],
                  ["--end-time-s", "0.1", "--delta-t", "-1"]):
        proc = stage(workdir, "cfd_transient", "--case-dir", case_dir,
                     "--velocity", "0.02,0,0", "--nu", "1e-6", *extra)
        assert proc.returncode == 1, extra
```

- [ ] **Step 6: 跑测试确认失败**

Run: `LD_LIBRARY_PATH="$HOME/miniconda3/envs/dsh-cae/lib" ~/miniconda3/envs/dsh-cae/bin/pytest pytest/test_cfd_transient.py -v`
Expected: FAIL（`No module named 'dsh_cae.cfd_transient'`）

- [ ] **Step 7: 写实现**

```python
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
        run = cfd_case.foam_run(bashrc, "foamRun", ["-Case", str(case_dir)], args.timeout_s)
    except subprocess.TimeoutExpired:
        fail(f"foamRun timed out after {args.timeout_s}s")
    wall_ms = int((time.monotonic() - start) * 1000)
    log_text = run.stdout + run.stderr
    log_path.write_text(log_text)

    vtk_path = None
    if run.returncode == 0:
        try:
            conv = cfd_case.foam_run(bashrc, "foamToVTK", ["-Case", str(case_dir), "-latestTime"],
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
```

- [ ] **Step 8: 跑测试确认通过**

Run: `LD_LIBRARY_PATH="$HOME/miniconda3/envs/dsh-cae/lib" ~/miniconda3/envs/dsh-cae/bin/pytest pytest/test_cfd_transient.py pytest/test_cfd_case.py -v`
Expected: 全部 passed（无 OpenFOAM 的环境里 test_cfd_transient 整文件 skip，只跑 test_cfd_case）

- [ ] **Step 9: Commit**

```bash
git add python/dsh_cae/cfd_case.py python/dsh_cae/cfd_transient.py pytest/test_cfd_case.py pytest/test_cfd_transient.py
git commit -m "feat: cfd_transient stage — Euler/PIMPLE transient march with Courant-limited step"
```

---

### Task 4: `cae_cfd_transient` TS 工具

**Files:**
- Create: `src/tools/cfd-transient.ts`
- Create: `tests/tools-cfd-transient.test.ts`
- Modify: `src/index.ts`

**Interfaces:**
- Consumes: `runStage(config, 'cfd_transient', argv, {signal, logFile})`（Task 3 的 stage）；`ensureDeps(config, signal, 'cfd')`；`runtimeFor`（docker 时丢 --bashrc）。
- Produces: `defineCaeCfdTransientTool(config)`，注册名 `cae_cfd_transient`；`CfdTransientReceipt` 导出接口（字段 = Task 3 receipt 逐一对齐）。

- [ ] **Step 1: 写失败测试**

```typescript
// tests/tools-cfd-transient.test.ts
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import { defineCaeCfdTransientTool } from '../src/tools/cfd-transient.ts'

vi.mock('../src/runner.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/runner.js')>()
  return { ...actual, ensureDeps: vi.fn(), runStage: vi.fn() }
})

const config = { python: 'python3', workdir: './cae-stub', stageTimeoutMs: 1000 } as const
const exec = () => ({ signal: new AbortController().signal }) as ToolRunContext
const runnerMod = async () => import('../src/runner.js')

const workdirs: string[] = []
const workdir = async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-cae-transient-'))
  workdirs.push(dir)
  return dir
}
afterAll(async () => {
  await Promise.all(workdirs.map(d => rm(d, { recursive: true, force: true })))
})

beforeEach(async () => {
  const runner = await runnerMod()
  vi.mocked(runner.runStage).mockReset()
  vi.mocked(runner.runStage).mockResolvedValue({ receipt: {}, logPath: '/tmp/stub.log' })
  vi.mocked(runner.ensureDeps).mockResolvedValue(undefined)
})

const base = { caseDir: '', inletVelocityMS: [0.02, 0, 0], kinematicViscosityM2S: 1e-6 } as const

describe('cae_cfd_transient validation', () => {
  it('rejects inletVelocityMS that is not [u, v, w]', async () => {
    const tool = defineCaeCfdTransientTool(config)
    await expect(tool.execute({ ...base, caseDir: './c', inletVelocityMS: [1], endTimeS: 1 }, exec()))
      .rejects.toThrow('inletVelocityMS must be [u, v, w]')
  })

  it('rejects non-positive endTimeS', async () => {
    const tool = defineCaeCfdTransientTool(config)
    await expect(tool.execute({ ...base, caseDir: './c', endTimeS: 0 }, exec()))
      .rejects.toThrow('endTimeS must be a positive number')
  })

  it('rejects writeIntervalS greater than endTimeS', async () => {
    const tool = defineCaeCfdTransientTool(config)
    await expect(tool.execute({ ...base, caseDir: './c', endTimeS: 0.1, writeIntervalS: 0.2 }, exec()))
      .rejects.toThrow('writeIntervalS must be in (0, endTimeS]')
  })

  it('rejects maxCourant <= 0 when deltaTS is not fixing the step', async () => {
    const tool = defineCaeCfdTransientTool(config)
    await expect(tool.execute({ ...base, caseDir: './c', endTimeS: 1, maxCourant: 0 }, exec()))
      .rejects.toThrow('maxCourant must be positive when deltaTS is not set')
  })

  it('rejects a case stem with path separators', async () => {
    const tool = defineCaeCfdTransientTool(config)
    await expect(tool.execute({ ...base, caseDir: './c', endTimeS: 1, case: 'a/b' }, exec()))
      .rejects.toThrow('path separators')
  })

  it('rejects a non-existent caseDir before spawning a stage', async () => {
    const tool = defineCaeCfdTransientTool(config)
    await expect(tool.execute({ ...base, caseDir: './no-such-case', endTimeS: 1 }, exec()))
      .rejects.toThrow('does not exist')
  })
})

describe('cae_cfd_transient argv + bashrc', () => {
  it('builds the transient argv', async () => {
    const work = await workdir()
    const caseDir = join(work, 'cfd', 'duct')
    await mkdir(caseDir, { recursive: true })
    const tool = defineCaeCfdTransientTool({ ...config, workdir: work })
    await tool.execute({
      caseDir, inletVelocityMS: [0.02, 0, 0], kinematicViscosityM2S: 1e-6,
      endTimeS: 2, writeIntervalS: 0.1, densityKgM3: 1000,
    }, exec())
    const runner = await runnerMod()
    const call = vi.mocked(runner.runStage).mock.calls.find(([, stage]) => stage === 'cfd_transient')
    expect(call).toBeDefined()
    const argv = call![2]
    expect(argv[argv.indexOf('--end-time-s') + 1]).toBe('2')
    expect(argv[argv.indexOf('--write-interval-s') + 1]).toBe('0.1')
    expect(argv[argv.indexOf('--max-co') + 1]).toBe('0.5')
    expect(argv).not.toContain('--delta-t')
  })

  it('drops --bashrc under the docker runtime', async () => {
    const work = await workdir()
    const caseDir = join(work, 'cfd', 'duct')
    await mkdir(caseDir, { recursive: true })
    const tool = defineCaeCfdTransientTool({
      ...config, workdir: work,
      python: 'docker://ghcr.io/daiyuhangsustc/dsh-cae:latest',
      openfoamBashrc: '/opt/openfoam11/etc/bashrc',
    })
    await tool.execute({ ...base, caseDir, endTimeS: 1 }, exec())
    const runner = await runnerMod()
    const argv = vi.mocked(runner.runStage).mock.calls
      .find(([, stage]) => stage === 'cfd_transient')![2]
    expect(argv).not.toContain('--bashrc')
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm vitest run tests/tools-cfd-transient.test.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 写实现**

```typescript
// src/tools/cfd-transient.ts
import { join, resolve } from 'node:path'
import { access, writeFile } from 'node:fs/promises'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { ensureDeps, runStage } from '../runner.js'
import { runtimeFor } from '../interpreter.js'
import type { Config } from '../config.js'

const DESCRIPTION =
  'Run a transient incompressible laminar solve (foamRun incompressibleFluid, Euler + PIMPLE) '
  + 'on a cae_cfd_mesh case, marching REAL physical seconds with a Courant-limited adaptive step. '
  + 'Choose steady (cae_cfd_steady) when only fully-developed/time-averaged quantities matter — '
  + 'it is far cheaper; choose transient for startup transients, vortex shedding, or any '
  + 'time-history dependence — and recommend the choice to the user, the decision is theirs. '
  + 'endTimeS/writeIntervalS are simulated seconds; maxCourant (default 0.5) caps stability, or '
  + 'pass deltaTS to fix the step. densityKgM3 is echoed — pass the same value to cae_post_process '
  + 'so kinematic pressure converts to Pa. overrides replace top-level entries in whitelisted '
  + 'case dicts, exactly and only.'

const OVERRIDE_FILES = [
  'system/controlDict', 'system/fvSchemes', 'system/fvSolution',
  'system/blockMeshDict', 'constant/physicalProperties', 'constant/momentumTransport',
] as const

/** Receipt shape of the `cfd_transient` stage, pinned for the tool's output schema. */
export interface CfdTransientReceipt {
  caseDir: string
  logPath: string
  vtkPath: string | null
  timeStepsRun: number
  simTimeS: number
  endTimeS: number
  maxCourantSeen: number | null
  finalResiduals: { p: number | null; U: number | null }
  wallMs: number
  exitCode: number
  logTail: string
  densityKgM3: number
}

/** Build the `cae_cfd_transient` tool bound to one deployment configuration. */
export function defineCaeCfdTransientTool(config: Config) {
  return defineTool({
    name: 'cae_cfd_transient',
    description: DESCRIPTION,
    parameters: {
      caseDir: { type: 'string', required: true, description: 'caseDir from cae_cfd_mesh.' },
      inletVelocityMS: {
        type: 'array', items: { type: 'number' }, required: true,
        description: 'Inlet velocity [u, v, w] in m/s.',
      },
      kinematicViscosityM2S: {
        type: 'number', required: true,
        description: 'Kinematic viscosity ν in m²/s (water ≈ 1e-6, air ≈ 1.5e-5).',
      },
      endTimeS: { type: 'number', required: true, description: 'Simulated physical seconds to march.' },
      maxCourant: { type: 'number', description: 'Courant cap for the adaptive step. Default 0.5.' },
      deltaTS: { type: 'number', description: 'Fixed time step in s; disables the Courant-limited adaptive step.' },
      writeIntervalS: { type: 'number', description: 'Result write interval in simulated seconds. Default endTimeS/10.' },
      densityKgM3: { type: 'number', description: 'Density kg/m³, echoed for cae_post_process. Default 1.' },
      overrides: {
        type: 'array',
        items: {
          type: 'object', additionalProperties: false,
          properties: {
            file: { type: 'string', required: true, enum: [...OVERRIDE_FILES] },
            entry: { type: 'string', required: true, description: 'Top-level entry to replace, e.g. endTime or PIMPLE.' },
            dict: { type: 'string', required: true, description: 'Full replacement text including the entry name and trailing ";".' },
          },
        },
        description: 'Exact top-level entry replacements applied before the solve.',
      },
      case: { type: 'string', description: 'Log/VTK stem inside the case. Default "run".' },
    },
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        properties: {
          caseDir: { type: 'string', required: true },
          logPath: { type: 'string', required: true },
          vtkPath: { oneOf: [{ type: 'string' }, { type: 'null' }], required: true },
          timeStepsRun: { type: 'integer', required: true },
          simTimeS: { type: 'number', required: true },
          endTimeS: { type: 'number', required: true },
          maxCourantSeen: { oneOf: [{ type: 'number' }, { type: 'null' }], required: true },
          finalResiduals: {
            type: 'object', additionalProperties: false, required: true,
            properties: {
              p: { oneOf: [{ type: 'number' }, { type: 'null' }], required: true },
              U: { oneOf: [{ type: 'number' }, { type: 'null' }], required: true },
            },
          },
          wallMs: { type: 'integer', required: true },
          exitCode: { type: 'integer', required: true },
          logTail: { type: 'string', required: true },
          densityKgM3: { type: 'number', required: true },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: `foamRun exit ${value.exitCode} — marched ${value.simTimeS} of ${value.endTimeS} s `
          + `in ${value.timeStepsRun} steps, max Co ${value.maxCourantSeen ?? 'n/a'}. `
          + `Results: ${value.vtkPath ?? value.logPath}`,
      }],
      presentationMeta: (_args, value) => ({ exitCode: value.exitCode, logTail: value.logTail }),
    },
    async execute(args, exec) {
      if (args.inletVelocityMS.length !== 3) {
        throw new Error(`inletVelocityMS must be [u, v, w], got ${JSON.stringify(args.inletVelocityMS)}`)
      }
      const endTimeS = args.endTimeS
      if (!(endTimeS > 0)) {
        throw new Error(`endTimeS must be a positive number, got ${endTimeS}`)
      }
      const writeIntervalS = args.writeIntervalS ?? endTimeS / 10
      if (!(writeIntervalS > 0) || writeIntervalS > endTimeS) {
        throw new Error(`writeIntervalS must be in (0, endTimeS], got ${writeIntervalS}`)
      }
      const maxCourant = args.maxCourant ?? 0.5
      if (args.deltaTS === undefined && !(maxCourant > 0)) {
        throw new Error(`maxCourant must be positive when deltaTS is not set, got ${maxCourant}`)
      }
      if (args.deltaTS !== undefined && !(args.deltaTS > 0)) {
        throw new Error(`deltaTS must be a positive number, got ${args.deltaTS}`)
      }
      const stem = args.case ?? 'run'
      if (stem.includes('/') || stem.includes('\\')) {
        throw new Error(`case stem '${stem}' must not contain path separators`)
      }
      const caseDir = resolve(args.caseDir)
      try {
        await access(caseDir)
      } catch {
        throw new Error(`caseDir '${caseDir}' does not exist — pass the caseDir returned by cae_cfd_mesh`)
      }
      await ensureDeps(config, exec.signal, 'cfd')
      const argv = [
        '--case-dir', caseDir,
        '--velocity', args.inletVelocityMS.join(','),
        '--nu', String(args.kinematicViscosityM2S),
        '--rho', String(args.densityKgM3 ?? 1),
        '--end-time-s', String(endTimeS),
        '--max-co', String(maxCourant),
        '--write-interval-s', String(writeIntervalS),
        '--case', stem,
      ]
      if (args.deltaTS !== undefined) argv.push('--delta-t', String(args.deltaTS))
      if (args.overrides?.length) {
        const ovrFile = join(caseDir, `${stem}.overrides.json`)
        await writeFile(ovrFile, JSON.stringify(args.overrides), 'utf8')
        argv.push('--overrides-file', ovrFile)
      }
      // Host bashrc paths don't exist inside the container; the image's
      // OpenFOAM is auto-detected (see runner.ts's identical guard).
      if (config.openfoamBashrc && runtimeFor(config).kind !== 'docker') {
        argv.push('--bashrc', config.openfoamBashrc)
      }
      const { receipt } = await runStage(config, 'cfd_transient', argv,
        { signal: exec.signal, logFile: `cfd.${stem}.transient.log` })
      return receipt as unknown as CfdTransientReceipt
    },
    presentCall: args => ({ card: 'terminal', title: `foamRun ${args.case ?? 'run'}`, description: 'Transient incompressible solve' }),
    presentResult: (_args, { meta }) => {
      const m = meta as { exitCode?: number; logTail?: string } | undefined
      return {
        card: 'terminal',
        output: m?.logTail ?? '',
        exitCode: m?.exitCode ?? -1,
      }
    },
  })
}
```

- [ ] **Step 4: 注册到 index.ts**

import 区加 `import { defineCaeCfdTransientTool } from './tools/cfd-transient.js'`；`apply()` 里 `defineCaeCfdSteadyTool(config)` 之后加 `ctx.tools.register(defineCaeCfdTransientTool(config))`。

- [ ] **Step 5: 跑测试确认通过 + 编译**

Run: `pnpm vitest run tests/tools-cfd-transient.test.ts && pnpm build`
Expected: 8 passed；tsc 无错误

- [ ] **Step 6: Commit**

```bash
git add src/tools/cfd-transient.ts tests/tools-cfd-transient.test.ts src/index.ts
git commit -m "feat: cae_cfd_transient tool — steady/transient recommendation lives in the descriptions"
```

---

### Task 5: `src/gci.ts` 纯数学

**Files:**
- Create: `src/gci.ts`
- Test: `tests/gci.test.ts`

**Interfaces:**
- Consumes: 无（纯函数，无 IO）。
- Produces:
  - `interface GciLevel { size: number; count: number; value: number }`
  - `interface GciResult { refinementRatios: { r21: number; r32: number }; convergenceState: 'monotonic' | 'oscillatory'; observedOrder: number | null; richardsonExtrapolated: number | null; gciFinePercent: number | null; gciCoarsePercent: number | null; meshIndependent: boolean; thresholdPercent: number }`
  - `function gci(levels: GciLevel[], thresholdPercent: number): GciResult`（levels 按 size 升序内部排序，index 1 = 最细）

- [ ] **Step 1: 写失败测试**

```typescript
// tests/gci.test.ts
import { describe, expect, it } from 'vitest'
import { gci } from '../src/gci.ts'
import type { GciLevel } from '../src/gci.ts'

// 制造解：φ = φ_ext + C·N^(−p/3)，count 取 (27000, 8000, 2370.37…) 精确比例 1.5³
const manufactured = (p: number, phiExt = 100, c = 1): GciLevel[] => {
  const mk = (n: number): GciLevel => ({ size: 1 / Math.cbrt(n), count: n, value: phiExt + c * n ** (-p / 3) })
  return [mk(27000), mk(8000), mk(8000 / 3.375), mk(8000 / 3.375 / 3.375)].slice(0, 3)
}

describe('gci', () => {
  it('recovers the manufactured observed order exactly for equal ratios', () => {
    const result = gci(manufactured(3), 3)
    expect(result.convergenceState).toBe('monotonic')
    expect(result.observedOrder).toBeCloseTo(3, 4)
    expect(result.richardsonExtrapolated).toBeCloseTo(100, 6)
    expect(result.meshIndependent).toBe(true)
  })

  it('computes the fine-grid GCI by the Celik formula', () => {
    const result = gci(manufactured(2, 100, 1), 3)
    // φ1 = 100 + 27000^(−2/3), φ2 = 100 + 8000^(−2/3); r = 1.5, p = 2
    const phi1 = 100 + 27000 ** (-2 / 3)
    const phi2 = 100 + 8000 ** (-2 / 3)
    const expectGci = 1.25 * Math.abs(phi2 - phi1) / (Math.abs(phi1) * (1.5 ** 2 - 1)) * 100
    expect(result.gciFinePercent).toBeCloseTo(expectGci, 6)
    expect(result.observedOrder).toBeCloseTo(2, 4)
  })

  it('flags oscillatory convergence as unreliable', () => {
    const levels: GciLevel[] = [
      { size: 1, count: 9000, value: 100 },
      { size: 1.5, count: 3000, value: 100.5 },
      { size: 2, count: 1000, value: 100.2 },
    ]
    const result = gci(levels, 3)
    expect(result.convergenceState).toBe('oscillatory')
    expect(result.observedOrder).toBeNull()
    expect(result.gciFinePercent).toBeNull()
    expect(result.meshIndependent).toBe(false)
  })

  it('respects the threshold: a large fine-grid GCI is not mesh-independent', () => {
    const result = gci(manufactured(2, 100, 50), 0.01)  // C=50 放大离散误差
    expect(result.meshIndependent).toBe(false)
    expect(result.gciFinePercent!).toBeGreaterThan(0.01)
  })

  it('throws below three levels', () => {
    expect(() => gci([{ size: 1, count: 10, value: 1 }, { size: 2, count: 5, value: 2 }], 3))
      .toThrow('at least 3')
  })

  it('accepts unsorted input (finest may come last)', () => {
    const sorted = manufactured(3)
    const result = gci([...sorted].reverse(), 3)
    expect(result.observedOrder).toBeCloseTo(3, 4)
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm vitest run tests/gci.test.ts`
Expected: FAIL（`../src/gci.ts` 不存在）

- [ ] **Step 3: 写实现**

```typescript
// src/gci.ts
/** Grid Convergence Index study (Celik et al. 2008) over ≥3 mesh levels.
 * Pure math — no IO, no stages; verify-mesh feeds it level results. */

export interface GciLevel {
  /** Characteristic element/cell size; any consistent unit (mm). */
  size: number
  /** Element/cell count at this level — drives the refinement ratio. */
  count: number
  /** The monitored scalar metric (e.g. max von Mises in MPa). */
  value: number
}

export interface GciResult {
  refinementRatios: { r21: number; r32: number }
  convergenceState: 'monotonic' | 'oscillatory'
  observedOrder: number | null
  richardsonExtrapolated: number | null
  gciFinePercent: number | null
  gciCoarsePercent: number | null
  meshIndependent: boolean
  thresholdPercent: number
}

/**
 * Study ≥3 mesh levels with the Celik et al. (2008) procedure. Levels are
 * sorted finest-first internally; refinement ratios come from cell-count cube
 * roots. Oscillatory convergence (non-monotonic values) yields null order/GCI
 * and meshIndependent=false — the numbers cannot be trusted.
 */
export function gci(levelsIn: GciLevel[], thresholdPercent: number): GciResult {
  if (levelsIn.length < 3) {
    throw new Error(`GCI needs at least 3 mesh levels, got ${levelsIn.length}`)
  }
  const levels = [...levelsIn].sort((a, b) => a.size - b.size) // index 1 = finest
  const [l1, l2, l3] = levels
  const r21 = Math.cbrt(l1.count / l2.count)
  const r32 = Math.cbrt(l3.count / l2.count)
  const e21 = l2.value - l1.value
  const e32 = l3.value - l2.value
  const base = {
    refinementRatios: { r21, r32 },
    thresholdPercent,
  }
  const monotonic = Math.abs(l1.value) > 0 && e21 * e32 > 0
  if (!monotonic) {
    return {
      ...base,
      convergenceState: 'oscillatory',
      observedOrder: null,
      richardsonExtrapolated: null,
      gciFinePercent: null,
      gciCoarsePercent: null,
      meshIndependent: false,
    }
  }
  const p = solveOrder(r21, r32, e21, e32)
  const richardsonExtrapolated = l1.value + e21 / (r21 ** p - 1)
  const gciFinePercent = 1.25 * Math.abs(e21) / (Math.abs(l1.value) * (r21 ** p - 1)) * 100
  const gciCoarsePercent = 1.25 * Math.abs(e32) / (Math.abs(l2.value) * (r32 ** p - 1)) * 100
  return {
    ...base,
    convergenceState: 'monotonic',
    observedOrder: p,
    richardsonExtrapolated,
    gciFinePercent,
    gciCoarsePercent,
    meshIndependent: gciFinePercent <= thresholdPercent,
  }
}

/** Fixed-point iteration for the observed order p (Celik Eq. 14–16); with
 * equal ratios it reduces to p = ln|ε32/ε21| / ln r in one step. */
function solveOrder(r21: number, r32: number, e21: number, e32: number): number {
  const s = Math.sign(e32 / e21)
  let p = 2
  for (let i = 0; i < 100; i += 1) {
    const q = Math.log((r21 ** p - s) / (r32 ** p - s))
    const next = (Math.log(Math.abs(e32 / e21)) + q) / Math.log(r21)
    if (Math.abs(next - p) < 1e-12) return next
    p = next
  }
  return p
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm vitest run tests/gci.test.ts`
Expected: 6 passed

- [ ] **Step 5: Commit**

```bash
git add src/gci.ts tests/gci.test.ts
git commit -m "feat: gci — Celik 2008 grid convergence index as pure functions"
```

---

### Task 6: `cae_verify_mesh` TS 宏工具

**Files:**
- Create: `src/tools/verify-mesh.ts`
- Create: `tests/verify-mesh.test.ts`
- Modify: `src/index.ts`

**Interfaces:**
- Consumes: `runStage` 调 5 个现有 stage（argv 契约照抄现有工具）：`mesh`（`--step --faces-json --msh --element-size`，receipt `nodeCount`）、`solve`（`--msh --case --young-mpa --poisson --fixed-group… --load-group/--load-n…`，receipt `vtuPath/frdPath`）、`cfd_mesh`（`--workdir --name --length-mm --width-mm --height-mm --cell-size-mm --wall-grading --bashrc?`，receipt `cells/caseDir`）、`cfd_steady`（`--case-dir --velocity --nu --rho --iterations --case`，receipt `converged/vtkPath`）、`post`（`--vtu|--frd --png-stem --max <field> | --probe p,x,y,z --density-kg-m3`，receipt `values[].value`）；`gci(levels, threshold)`（Task 5）；`ensureDeps`（structural|cfd 按链）。
- Produces: `defineCaeVerifyMeshTool(config)`，注册名 `cae_verify_mesh`；`VerifyMeshReceipt` 导出接口。

- [ ] **Step 1: 写失败测试**

```typescript
// tests/verify-mesh.test.ts
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import { defineCaeVerifyMeshTool } from '../src/tools/verify-mesh.ts'

vi.mock('../src/runner.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/runner.js')>()
  return { ...actual, ensureDeps: vi.fn(), runStage: vi.fn() }
})

const config = { python: 'python3', workdir: './cae-stub', stageTimeoutMs: 1000 } as const
const exec = () => ({ signal: new AbortController().signal }) as ToolRunContext
const runnerMod = async () => import('../src/runner.js')

const workdirs: string[] = []
const workdir = async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-cae-verify-'))
  workdirs.push(dir)
  return dir
}
afterAll(async () => {
  await Promise.all(workdirs.map(d => rm(d, { recursive: true, force: true })))
})

// 制造解计数（精确比 1.5）：v = 100 + 1/N → p = 3，GCI≈0
const COUNTS: Record<string, number> = { '8': 1000, '5': 3375, '3': 11390.625 }
const valueFor = (count: number) => 100 + 1 / count

// post 的 metric 值由 mesh 顺序驱动：mesh/cfd_mesh 见到 size 时 push，post 弹出
// 队首 —— verify-mesh 按粗→细逐档执行，post 第 k 次 = 第 k 档。
const sizeQueue: number[] = []

const structuralArgs = {
  chain: 'structural' as const,
  step: '/tmp/beam.step',
  facesJson: '/tmp/beam.faces.json',
  material: { youngMPa: 210000, poisson: 0.3 },
  fixedGroups: ['fixed'],
  loads: [{ group: 'load', forceN: [0, 0, -1000] }],
  elementSizesMm: [3, 5, 8],   // 乱序输入
}

beforeEach(async () => {
  const runner = await runnerMod()
  sizeQueue.length = 0
  vi.mocked(runner.runStage).mockReset()
  vi.mocked(runner.runStage).mockImplementation(async (_cfg, stage, argv) => {
    const flag = (name: string) => {
      const i = argv.indexOf(name)
      return i >= 0 ? argv[i + 1] : undefined
    }
    if (stage === 'mesh') {
      const size = flag('--element-size')!
      sizeQueue.push(Number(size))
      return { receipt: { nodeCount: COUNTS[size] ?? 1000 }, logPath: '' }
    }
    if (stage === 'solve') {
      return { receipt: { vtuPath: '/tmp/x.vtu', frdPath: '/tmp/x.frd' }, logPath: '' }
    }
    if (stage === 'post') {
      const size = String(sizeQueue.shift())
      return { receipt: { values: [{ value: valueFor(COUNTS[size] ?? 8000) }] }, logPath: '' }
    }
    if (stage === 'cfd_mesh') {
      const size = flag('--cell-size-mm')!
      sizeQueue.push(Number(size))
      return { receipt: { cells: COUNTS[size] ?? 1000, caseDir: '/tmp/cfd/verify-l0' }, logPath: '' }
    }
    if (stage === 'cfd_steady') {
      return { receipt: { converged: true, vtkPath: '/tmp/y.vtk' }, logPath: '' }
    }
    throw new Error(`unexpected stage ${stage}`)
  })
  vi.mocked(runner.ensureDeps).mockResolvedValue(undefined)
})
```

```typescript
describe('cae_verify_mesh validation', () => {
  it('rejects fewer than 3 sizes', async () => {
    const tool = defineCaeVerifyMeshTool({ ...config, workdir: await workdir() })
    await expect(tool.execute({ ...structuralArgs, elementSizesMm: [8, 5] }, exec()))
      .rejects.toThrow('at least 3')
  })

  it('rejects non-monotonic sizes', async () => {
    const tool = defineCaeVerifyMeshTool({ ...config, workdir: await workdir() })
    await expect(tool.execute({ ...structuralArgs, elementSizesMm: [8, 5, 8] }, exec()))
      .rejects.toThrow('strictly monotonic')
  })

  it('requires structural loads and fixedGroups', async () => {
    const tool = defineCaeVerifyMeshTool({ ...config, workdir: await workdir() })
    await expect(tool.execute({ ...structuralArgs, loads: [] }, exec()))
      .rejects.toThrow('at least one load')
  })
})

describe('cae_verify_mesh structural chain', () => {
  it('meshes, solves, and posts per level in coarse-to-fine order', async () => {
    const work = await workdir()
    const step = join(work, 'beam.step')
    const faces = join(work, 'beam.faces.json')
    await writeFile(step, 'x')
    await writeFile(faces, '{}')
    const tool = defineCaeVerifyMeshTool({ ...config, workdir: work })
    const receipt = await tool.execute({ ...structuralArgs, step, facesJson: faces }, exec())
    const runner = await runnerMod()
    const stages = vi.mocked(runner.runStage).mock.calls.map(([, s]) => s)
    expect(stages).toEqual(['mesh', 'solve', 'post', 'mesh', 'solve', 'post', 'mesh', 'solve', 'post'])
    const sizes = vi.mocked(runner.runStage).mock.calls
      .filter(([, s]) => s === 'mesh')
      .map(([,, argv]) => argv[argv.indexOf('--element-size') + 1])
    expect(sizes).toEqual(['8', '5', '3'])  // 粗→细
    expect(receipt.levels.map((l: any) => l.sizeMm)).toEqual([8, 5, 3])
    expect(receipt.levels.map((l: any) => l.count)).toEqual([1000, 3375, 11390.625])
    expect(receipt.observedOrder).toBeCloseTo(3, 3)
    expect(receipt.meshIndependent).toBe(true)
    expect(receipt.recommendation).toContain('8')
  })

  it('labels the failing level when a stage dies mid-study', async () => {
    const runner = await runnerMod()
    vi.mocked(runner.runStage).mockImplementation(async (_cfg, stage) => {
      if (stage === 'post') return Promise.reject(new Error('boom'))
      return { receipt: { nodeCount: 1, vtuPath: '/x.vtu', frdPath: '/x.frd' }, logPath: '' }
    })
    const tool = defineCaeVerifyMeshTool({ ...config, workdir: await workdir() })
    await expect(tool.execute({ ...structuralArgs }, exec()))
      .rejects.toThrow('level 1')
  })
})

describe('cae_verify_mesh cfd chain', () => {
  const cfdArgs = {
    chain: 'cfd' as const,
    lengthMm: 1000, widthMm: 20, heightMm: 20,
    inletVelocityMS: [0.02, 0, 0], kinematicViscosityM2S: 1e-6,
    cellSizesMm: [8, 5, 3], densityKgM3: 1000,
  }

  it('fails the study when a level does not converge', async () => {
    const runner = await runnerMod()
    const orig = vi.mocked(runner.runStage).getMockImplementation()
    vi.mocked(runner.runStage).mockImplementation(async (cfg, stage, argv) => {
      const out = await orig!(cfg, stage, argv)
      if (stage === 'cfd_steady') out.receipt = { ...out.receipt, converged: false }
      return out
    })
    const tool = defineCaeVerifyMeshTool({ ...config, workdir: await workdir() })
    await expect(tool.execute({ ...cfdArgs }, exec()))
      .rejects.toThrow('did not converge')
  })

  it('computes pressure drop from inlet/outlet probes', async () => {
    const work = await workdir()
    const runner = await runnerMod()
    const orig = vi.mocked(runner.runStage).getMockImplementation()
    vi.mocked(runner.runStage).mockImplementation(async (cfg, stage, argv) => {
      if (stage === 'post') {
        const probes = argv.filter(a => a.startsWith('p,'))
        expect(probes).toHaveLength(2)
        expect(probes[0]).toMatch(/^p,0\.004,0\.01,0\.01$/)       // 8mm 档: eps=cell/2=4mm
        return { receipt: { values: [{ value: 12.5 }, { value: 2.5 }] }, logPath: '' }
      }
      return orig!(cfg, stage, argv)
    })
    const tool = defineCaeVerifyMeshTool({ ...config, workdir: work })
    await tool.execute({ ...cfdArgs, metric: 'pressureDropPa' }, exec())
  })
})
```

（cfd 探针坐标：进口 `p,eps,W/2,H/2`、出口 `p,L−eps,W/2,H/2`，单位米；eps = 该档 cellSize/2 换米。8mm 档、W=H=20mm → `p,0.004,0.01,0.01`。）

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm vitest run tests/verify-mesh.test.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 写实现**

```typescript
// src/tools/verify-mesh.ts
import { join, resolve } from 'node:path'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { ensureDeps, runStage } from '../runner.js'
import { runtimeFor } from '../interpreter.js'
import { gci } from '../gci.js'
import type { GciLevel } from '../gci.js'
import type { Config } from '../config.js'

const DESCRIPTION =
  'Mesh-independence study (stage-5 verification): re-mesh at 3+ sizes, run the identical '
  + 'solve at every level, extract one monitored metric, and report the Richardson observed '
  + 'order + GCI (Celik 2008) with a threshold verdict. chain="structural" needs the same '
  + 'inputs as cae_solve_static plus elementSizesMm; chain="cfd" re-meshes the parametric duct '
  + 'at cellSizesMm and runs cae_cfd_steady per level. This is the MOST EXPENSIVE tool — a '
  + 'full mesh+solve per size. A CFD level that does not converge fails the study (loosen '
  + 'SIMPLE residualControl via cae_cfd_steady retries first); oscillatory convergence reports '
  + 'meshIndependent=false because the numbers cannot be trusted. meshIndependent=true when the '
  + 'fine-grid GCI is within gciThresholdPercent (default 3%).'

/** Receipt of cae_verify_mesh: per-level table + the GCI study + a verdict. */
export interface VerifyMeshReceipt {
  chain: 'structural' | 'cfd'
  metric: string
  levels: { sizeMm: number; count: number; metricValue: number }[]
  refinementRatios: { r21: number; r32: number }
  convergenceState: 'monotonic' | 'oscillatory'
  observedOrder: number | null
  richardsonExtrapolated: number | null
  gciFinePercent: number | null
  gciCoarsePercent: number | null
  meshIndependent: boolean
  thresholdPercent: number
  recommendation: string
}

type LevelRow = VerifyMeshReceipt['levels'][number]

/** Build the `cae_verify_mesh` tool bound to one deployment configuration. */
export function defineCaeVerifyMeshTool(config: Config) {
  return defineTool({
    name: 'cae_verify_mesh',
    description: DESCRIPTION,
    parameters: {
      chain: { type: 'string', enum: ['structural', 'cfd'], required: true, description: 'Which chain to study.' },
      elementSizesMm: { type: 'array', items: { type: 'number' }, description: 'structural: ≥3 strictly monotonic element sizes, e.g. [8, 5, 3].' },
      cellSizesMm: { type: 'array', items: { type: 'number' }, description: 'cfd: ≥3 strictly monotonic cell sizes.' },
      metric: {
        type: 'string', enum: ['maxVonMises', 'maxDisplacement', 'maxVelocityMS', 'pressureDropPa'],
        description: 'Monitored scalar. Default maxVonMises (structural) / maxVelocityMS (cfd).',
      },
      gciThresholdPercent: { type: 'number', description: 'Fine-grid GCI percent below which the mesh counts as independent. Default 3.' },
      // structural inputs (mirror cae_solve_static)
      step: { type: 'string', description: 'structural: the .step from cae_cad_build / cae_step_import.' },
      facesJson: { type: 'string', description: 'structural: the faces.json sidecar.' },
      material: {
        type: 'object', additionalProperties: false,
        properties: {
          youngMPa: { type: 'number', required: true },
          poisson: { type: 'number', required: true },
        },
        required: ['youngMPa', 'poisson'],
      },
      fixedGroups: { type: 'array', items: { type: 'string' }, description: 'structural: constrained face groups.' },
      loads: {
        type: 'array',
        items: {
          type: 'object', additionalProperties: false,
          properties: {
            group: { type: 'string', required: true },
            forceN: { type: 'array', items: { type: 'number' }, required: true },
          },
          required: ['group', 'forceN'],
        },
      },
      // cfd inputs (mirror cae_cfd_mesh + cae_cfd_steady)
      lengthMm: { type: 'number' },
      widthMm: { type: 'number' },
      heightMm: { type: 'number' },
      wallGrading: { type: 'number' },
      inletVelocityMS: { type: 'array', items: { type: 'number' } },
      kinematicViscosityM2S: { type: 'number' },
      densityKgM3: { type: 'number' },
    },
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        properties: {
          chain: { type: 'string', required: true },
          metric: { type: 'string', required: true },
          levels: {
            type: 'array', required: true,
            items: { type: 'object', additionalProperties: false, properties: {
              sizeMm: { type: 'number', required: true },
              count: { type: 'number', required: true },
              metricValue: { type: 'number', required: true },
            } },
          },
          refinementRatios: {
            type: 'object', additionalProperties: false, required: true,
            properties: { r21: { type: 'number', required: true }, r32: { type: 'number', required: true } },
          },
          convergenceState: { type: 'string', enum: ['monotonic', 'oscillatory'], required: true },
          observedOrder: { oneOf: [{ type: 'number' }, { type: 'null' }], required: true },
          richardsonExtrapolated: { oneOf: [{ type: 'number' }, { type: 'null' }], required: true },
          gciFinePercent: { oneOf: [{ type: 'number' }, { type: 'null' }], required: true },
          gciCoarsePercent: { oneOf: [{ type: 'number' }, { type: 'null' }], required: true },
          meshIndependent: { type: 'boolean', required: true },
          thresholdPercent: { type: 'number', required: true },
          recommendation: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: `mesh ${value.meshIndependent ? 'INDEPENDENT' : 'NOT independent'} `
          + `(GCI_fine ${value.gciFinePercent ?? 'n/a'}% vs ${value.thresholdPercent}% threshold, `
          + `order ${value.observedOrder ?? 'n/a'}, ${value.convergenceState}). `
          + `${value.recommendation}`,
      }],
    },
    async execute(args, exec) {
      const isStructural = args.chain === 'structural'
      const sizesRaw = (isStructural ? args.elementSizesMm : args.cellSizesMm) ?? []
      const label = isStructural ? 'elementSizesMm' : 'cellSizesMm'
      if (sizesRaw.length < 3) {
        throw new Error(`need at least 3 ${label} for a GCI study, got ${sizesRaw.length}`)
      }
      if (!sizesRaw.every((s, i) => i === 0 || Math.abs(s - sizesRaw[i - 1]) > 1e-12)) {
        throw new Error(`${label} must be strictly monotonic`)
      }
      if (isStructural) {
        if (!args.step) throw new Error('chain=structural needs step')
        if (!args.material) throw new Error('chain=structural needs material')
        if (!args.fixedGroups?.length) throw new Error('chain=structural needs at least one fixedGroups entry')
        if (!args.loads?.length) throw new Error('chain=structural needs at least one load')
      } else {
        if (![args.lengthMm, args.widthMm, args.heightMm].every(v => typeof v === 'number')) {
          throw new Error('chain=cfd needs lengthMm, widthMm, heightMm')
        }
        if (!args.inletVelocityMS || !args.kinematicViscosityM2S) {
          throw new Error('chain=cfd needs inletVelocityMS and kinematicViscosityM2S')
        }
      }
      const metric = args.metric ?? (isStructural ? 'maxVonMises' : 'maxVelocityMS')
      const threshold = args.gciThresholdPercent ?? 3
      const workdirAbs = resolve(config.workdir)
      await ensureDeps(config, exec.signal, isStructural ? 'structural' : 'cfd')
      const ordered = [...sizesRaw].sort((a, b) => b - a) // coarsest first

      const levels: LevelRow[] = []
      for (const [i, size] of ordered.entries()) {
        try {
          levels.push(await runLevel(config, exec.signal, args, { workdirAbs, i, size, metric, isStructural }))
        } catch (error) {
          throw new Error(`mesh-independence level ${i + 1} of ${ordered.length} (${size} mm) failed: ${(error as Error).message}`)
        }
      }

      const study = gci(levels.map((l): GciLevel => ({ size: l.sizeMm, count: l.count, value: l.metricValue })), threshold)
      const recommendation = recommend(levels, study.richardsonExtrapolated, threshold)
      return { chain: args.chain, metric, levels, ...study, recommendation } as VerifyMeshReceipt
    },
    presentCall: args => ({
      card: 'terminal', title: 'verify mesh', description: `mesh-independence study (${args.chain}, ${args.elementSizesMm?.length ?? args.cellSizesMm?.length ?? '?'} levels)`,
    }),
  })
}

/** One level: mesh → solve → metric extraction. Returns the level row. */
async function runLevel(
  config: Config, signal: AbortSignal | undefined,
  args: VerifyMeshArgs, ctx: { workdirAbs: string; i: number; size: number; metric: string; isStructural: boolean },
): Promise<LevelRow> {
  const { workdirAbs, i, size, metric, isStructural } = ctx
  if (isStructural) {
    const dir = join(workdirAbs, 'verify', `l${i}`)
    const msh = join(dir, 'part.msh')
    const meshArgv = ['--step', resolve(args.step!), '--msh', msh, '--element-size', String(size)]
    if (args.facesJson) meshArgv.push('--faces-json', resolve(args.facesJson))
    const mesh = await runStage(config, 'mesh', meshArgv, { signal, logFile: `verify.l${i}.mesh.log` })
    const solveArgv = [
      '--msh', msh, '--case', join(dir, 'case'),
      '--young-mpa', String(args.material!.youngMPa),
      '--poisson', String(args.material!.poisson),
      ...args.fixedGroups!.flatMap(g => ['--fixed-group', g]),
      // '=' form: a plain '--load-n -1000,0,0' would be eaten as an option flag
      ...args.loads!.flatMap(l => ['--load-group', l.group, `--load-n=${l.forceN.join(',')}`]),
    ]
    const solve = await runStage(config, 'solve', solveArgv, { signal, logFile: `verify.l${i}.solve.log` })
    const result = solve.receipt.vtuPath ?? solve.receipt.frdPath
    if (!result) throw new Error('solve produced neither vtu nor frd result')
    const field = metric === 'maxVonMises' ? 'vonMises' : 'displacement'
    const postArgv = ['--png-stem', join(dir, 'post'), '--max', field,
                      solve.receipt.vtuPath ? '--vtu' : '--frd', String(result)]
    const post = await runStage(config, 'post', postArgv, { signal, logFile: `verify.l${i}.post.log` })
    const value = (post.receipt.values as { value: number }[])[0]?.value
    if (typeof value !== 'number') throw new Error('post produced no metric value')
    return { sizeMm: size, count: mesh.receipt.nodeCount as number, metricValue: value }
  }

  const name = `verify-l${i}`
  const meshArgv = [
    '--workdir', workdirAbs, '--name', name,
    '--length-mm', String(args.lengthMm!), '--width-mm', String(args.widthMm!),
    '--height-mm', String(args.heightMm!), '--cell-size-mm', String(size),
    '--wall-grading', String(args.wallGrading ?? 1),
  ]
  // Host bashrc paths don't exist inside the container (same guard as the cfd tools).
  if (config.openfoamBashrc && runtimeFor(config).kind !== 'docker') {
    meshArgv.push('--bashrc', config.openfoamBashrc)
  }
  const mesh = await runStage(config, 'cfd_mesh', meshArgv, { signal, logFile: `verify.l${i}.cfd-mesh.log` })
  const cells = mesh.receipt.cells
  if (typeof cells !== 'number') throw new Error('cfd_mesh receipt has no cell count — cannot compute refinement ratios')
  const caseDir = String(mesh.receipt.caseDir)
  const steadyArgv = [
    '--case-dir', caseDir, '--velocity', args.inletVelocityMS!.join(','),
    '--nu', String(args.kinematicViscosityM2S!), '--rho', String(args.densityKgM3 ?? 1),
    '--iterations', '2000', '--case', 'run',
  ]
  if (config.openfoamBashrc && runtimeFor(config).kind !== 'docker') {
    steadyArgv.push('--bashrc', config.openfoamBashrc)
  }
  const steady = await runStage(config, 'cfd_steady', steadyArgv, { signal, logFile: `verify.l${i}.steady.log` })
  if (steady.receipt.converged !== true) {
    throw new Error('cfd_steady did not converge at this level — raise iterations or loosen SIMPLE residualControl before studying mesh independence')
  }
  const vtk = steady.receipt.vtkPath
  if (!vtk) throw new Error('cfd_steady produced no VTK result')
  const stem = join(caseDir, `verify-l${i}`)
  let postArgv: string[]
  let extract: (values: { value: number }[]) => number
  if (metric === 'pressureDropPa') {
    const [L, W, H] = [args.lengthMm! / 1000, args.widthMm! / 1000, args.heightMm! / 1000]
    const eps = size / 2000 // half a cell, meters
    postArgv = ['--vtu', String(vtk), '--png-stem', stem,
                '--probe', `p,${eps},${W / 2},${H / 2}`, '--probe', `p,${L - eps},${W / 2},${H / 2}`,
                '--density-kg-m3', String(args.densityKgM3 ?? 1)]
    extract = values => values[0].value - values[1].value
  } else {
    postArgv = ['--vtu', String(vtk), '--png-stem', stem, '--max', 'velocity']
    extract = values => values[0].value
  }
  const post = await runStage(config, 'post', postArgv, { signal, logFile: `verify.l${i}.post.log` })
  const values = post.receipt.values as { value: number }[]
  if (!values || values.length < (metric === 'pressureDropPa' ? 2 : 1)) throw new Error('post produced no metric value')
  return { sizeMm: size, count: cells, metricValue: extract(values) }
}

/** Coarsest level already within threshold of the extrapolated metric. */
function recommend(levels: LevelRow[], extrapolated: number | null, thresholdPercent: number): string {
  if (extrapolated === null) {
    return 'grid convergence is oscillatory — do not trust any single level; inspect the levels table and refine between levels'
  }
  const pick = levels.find(l => Math.abs(l.metricValue - extrapolated) / Math.abs(extrapolated) * 100 <= thresholdPercent)
  if (!pick) {
    return `no level is within ${thresholdPercent}% of the extrapolated value — refine further and re-run`
  }
  return `${pick.sizeMm} mm is already within ${thresholdPercent}% of the extrapolated metric; finer levels add cost, not accuracy`
}
```

还需要一个 `VerifyMeshArgs` 类型 —— 直接内联到 `runLevel` 的参数里会很长；实现文件顶部用工具参数的推导类型：

```typescript
// 放在 defineCaeVerifyMeshTool 内部 execute 的 args 类型即工具推导类型；
// runLevel 需要文件级类型，用 Parameters 提取：
type VerifyMeshArgs = Parameters<ReturnType<typeof defineCaeVerifyMeshTool>['execute']>[0]
```

（放在 `runLevel` 定义之前；`execute` 第一个形参类型就是 dsh-tools 推导的参数对象。）

- [ ] **Step 4: 注册到 index.ts**

import 区加 `import { defineCaeVerifyMeshTool } from './tools/verify-mesh.js'`；`apply()` 末尾加 `ctx.tools.register(defineCaeVerifyMeshTool(config))`。

- [ ] **Step 5: 跑测试确认通过 + 编译**

Run: `pnpm vitest run tests/verify-mesh.test.ts && pnpm build`
Expected: 6 passed；tsc 无错误

- [ ] **Step 6: 全量回归**

Run: `pnpm vitest run`
Expected: 既有全部 passed + 新增（tools-step-import 2 + tools-cfd-transient 8 + gci 6 + verify-mesh 6 = 22 条新）

- [ ] **Step 7: Commit**

```bash
git add src/tools/verify-mesh.ts tests/verify-mesh.test.ts src/index.ts
git commit -m "feat: cae_verify_mesh — automated mesh-independence study with Celik GCI"
```

---

### Task 7: 文档 + 版本

**Files:**
- Modify: `README.md`、`README.zh.md`
- Modify: `package.json`

**Interfaces:**
- Consumes: 前 6 个任务的最终行为。
- Produces: v0.4.0 发布就绪状态。

- [ ] **Step 1: README.md 更新**

1. 工具清单（现有 six tools 段落）改为 nine，补三个新工具的一句话说明：
   - `cae_step_import` — external STEP entry: validation, OCCT healing, face table + naming for BC anchors
   - `cae_cfd_transient` — Euler/PIMPLE transient branch of the CFD chain; steady-vs-transient recommendation lives in the tool descriptions
   - `cae_verify_mesh` — stage-5 verification: automated mesh-independence study (Richardson order + GCI)
2. 六阶段映射表（若 v0.3.0 已有则更新，没有则新增）：

```markdown
| Fluent stage | dsh-cae coverage |
| --- | --- |
| 1 Pre-processing | `cae_cad_build` (script geometry) · `cae_step_import` (external STEP: validate/heal/name faces) · `cae_mesh_generate` / `cae_cfd_mesh` |
| 2 Solver setup | parameters of the solve tools (materials, BCs, ν); steady vs transient is a recommendation the agent makes, the user decides |
| 3 Solution | `cae_solve_static` (CalculiX) · `cae_cfd_steady` / `cae_cfd_transient` (foamRun) |
| 4 Post-processing | `cae_post_process` (PyVista) |
| 5 Verification | `cae_verify_mesh` (mesh independence, Richardson + GCI); convergence receipts on every solve |
| 6 Validation | deliberately human — the plugin provides the numbers and plots, the engineer compares against reality |
```

3. Docker/工具表中 stage 列表如有 "six" 字样同步改 "nine"。

- [ ] **Step 2: README.zh.md 镜像更新**

同样三处，中文表述；阶段 6 行写明"刻意留给人工：插件提供数据（receipt 数字 + 云图），与物理现实的对比由工程师完成"。

- [ ] **Step 3: package.json 版本**

`"version": "0.3.0"` → `"version": "0.4.0"`。

- [ ] **Step 4: 全量双栈回归**

Run: `pnpm vitest run && pnpm build`
Run: `LD_LIBRARY_PATH="$HOME/miniconda3/envs/dsh-cae/lib" ~/miniconda3/envs/dsh-cae/bin/pytest pytest -v`
Expected: TS 全绿；Python 全绿（无 OpenFOAM 环境下 CFD 文件 skip）

- [ ] **Step 5: Commit**

```bash
git add README.md README.zh.md package.json
git commit -m "docs: v0.4.0 — nine tools, six-stage workflow mapping, human-validation boundary"
```

---

## Self-Review 记录

- **Spec 覆盖**：F1 = Task 1+2（校验/修复/面清单/命名 sidecar/致命三例外）；F2 = Task 3+4（Euler/PIMPLE/controlDict/推荐语义在描述）；F3 = Task 5+6（双链宏工具、Celik 数学、振荡判别、阈值判定、recommendation）；阶段6丢弃 + README = Task 7；版本 = Task 7。零新依赖 ✓（OCP 已在镜像、GCI 纯 TS）。
- **占位符扫描**：初稿两处内联自纠（Task 1 `mergeable` 行、Task 6 mock 的 post 分支）已定稿为单一正确版本写入正文，无残留 TBD/TODO。
- **类型一致性**：`StepImportReceipt`/`CfdTransientReceipt`/`VerifyMeshReceipt` 字段与各 python receipt 逐一对齐；`gci()` 签名在 Task 5 定义、Task 6 消费（`GciLevel` 同名导入）；stage 名 `step_import`/`cfd_transient` 两端一致。
- **自查修订**（已并入正文）：① verify-mesh 对 `cfd_mesh`/`cfd_steady` 转发 `--bashrc`（docker 运行时丢弃，与 cfd 工具同款守卫）；② `cfd_transient` 参数校验先于 case 目录存在性检查（坏参数测试不依赖先造 case）；③ `write_control_dict_transient` 自建 `system/` 目录（纯解析测试直接对空 tmp_path 调用）；④ solve 载荷用 `--load-n=v` 等号形式，argparse 不会把负向量当选项吞掉。
- **已知执行风险**：① `test_transient_fixed_delta_t` 断言 `timeStepsRun == 20` 依赖 adjustableRunTime 对齐（fixed deltaT + writeControl adjustableRunTime 会微调步长落 write 点，可能 21 步）——执行时若失败，放宽为 `>= 20` 并断言 `simTimeS ≈ 0.02`；② `simTimeS == 0.05` 的 `abs=1e-6` 容差在 OpenFOAM timePrecision 6 下应精确命中，若 flaky 放宽到 `abs=1e-4`；③ mock 的 `getMockImplementation()` 链式包装（cfd not-converge 测试）依赖 beforeEach 已设置实现，成立。
