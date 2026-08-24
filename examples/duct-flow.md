# Demo: natural-language duct-flow simulation

Install the plugin into a profile, boot it, and paste:

> 建一个 20×20 mm 方形截面、长 1 m 的水管，水温（ν=1e-6 m²/s，ρ=1000 kg/m³），
> 入口流速 0.02 m/s。做稳态层流求解：报告充分发展段的压降梯度并与层流理论值
> （方管 f·Re=56.91，ΔP/L≈1.42 Pa/m）对比，给出中心线最大流速，并出压力云图。

Expected agent flow: `cae_cfd_mesh` → `cae_cfd_steady` → `cae_post_process`
(units: mm in, SI out — the mesh tool converts once).

## 1. Mesh the duct

```json
{ "lengthMm": 1000, "widthMm": 20, "heightMm": 20, "cellSizeMm": 2.5, "name": "duct" }
```

```json
{
  "caseDir": "/tmp/cae/cfd/duct",
  "blockMeshDictPath": "/tmp/cae/cfd/duct/system/blockMeshDict",
  "boundsM": { "min": [0.0, 0.0, 0.0], "max": [1.0, 0.02, 0.02] },
  "cells": 25600,
  "maxNonOrthogonalityDeg": 0.0,
  "maxAspectRatio": 1.0,
  "checksPassed": true,
  "checkMeshLogPath": "/tmp/cae/cfd/duct/checkMesh.log",
  "logTail": "..."
}
```

## 2. Solve

The `overrides` parameter replaces `SIMPLE` in `system/fvSolution`: the template
default `residualControl p 1e-4; U 1e-5` never triggers, because the smoothSolver
Uy/Uz initial residuals plateau at ~7e-4 (a solver floor, not a convergence
signal); `p 1e-3; U 1e-3` is reachable and far tighter than the physics gate needs.

```json
{
  "caseDir": "/tmp/cae/cfd/duct",
  "inletVelocityMS": [0.02, 0, 0],
  "kinematicViscosityM2S": 1e-6,
  "densityKgM3": 1000,
  "iterations": 1500,
  "overrides": [
    { "file": "system/fvSolution", "entry": "SIMPLE",
      "dict": "SIMPLE { nNonOrthogonalCorrectors 0; consistent yes; residualControl { p 1e-3; U 1e-3; } }" }
  ]
}
```

```json
{
  "caseDir": "/tmp/cae/cfd/duct",
  "logPath": "/tmp/cae/cfd/duct/run.foam.log",
  "vtkPath": "/tmp/cae/cfd/duct/VTK/duct_55.vtk",
  "iterationsRun": 55,
  "converged": true,
  "finalResiduals": { "p": 9.21828e-07, "U": 6.00089e-05 },
  "wallMs": 2450,
  "exitCode": 0,
  "logTail": "...",
  "densityKgM3": 1000
}
```

## 3. Post-process

`densityKgM3: 1000` (echoed by the solve) converts the kinematic pressure to Pa.

```json
{
  "vtu": "/tmp/cae/cfd/duct/VTK/duct_55.vtk",
  "densityKgM3": 1000,
  "probes": [
    { "field": "pressure", "point": [0.5, 0.01, 0.01] },
    { "field": "pressure", "point": [0.9, 0.01, 0.01] },
    { "field": "velocity", "point": [0.9, 0.01, 0.01] }
  ],
  "plots": [ { "field": "pressure" } ]
}
```

```json
{
  "values": [
    { "kind": "probe", "field": "pressure", "value": 0.678734, "unit": "Pa", "atM": [0.5, 0.01, 0.01] },
    { "kind": "probe", "field": "pressure", "value": 0.134694, "unit": "Pa", "atM": [0.9, 0.01, 0.01] },
    { "kind": "probe", "field": "velocity", "value": 0.0390439, "unit": "m/s", "atM": [0.9, 0.01, 0.01] }
  ],
  "plots": [ { "field": "pressure", "path": "/tmp/cae/cfd/duct/VTK/duct_55.pressure.png" } ]
}
```

## Reading the numbers against theory

Probes at x=0.5/0.9 m sit past the ≈0.4 m entrance length (0.05·Re·D_h at Re=400).
Shah–London gives the Darcy constant f·Re = 56.91 for a square section:

ΔP/L = (f·Re)·μU/(2·D_h²) = 56.91 · 1e-3 · 0.02 / (2 · 0.02²) ≈ **1.42 Pa/m**

Measured: (0.678734 − 0.134694) / 0.4 = **1.360 Pa/m** (−4.4%, within the ±5% gate),
and centerline Umax/Umean = 0.0390439 / 0.02 = **1.95** vs the tabulated 2.10
(−7.0%, within the ±10% gate) — exactly the assertion
pytest/test_cfd_pipeline.py makes: the pipeline is answering the physics question
the user actually asked.

A full derivation-and-verification walkthrough of this case (theory,
mesh, solver settings, and the checks above) is in
[square_duct_laminar_tutorial.pdf](square_duct_laminar_tutorial.pdf).
