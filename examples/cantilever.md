# Demo: natural-language cantilever simulation

Install the plugin into a profile, boot it, and paste:

> 建一根 100×20×5 mm 的悬臂梁：左端面固定，右端面施加 100 N 向下的力。
> 材料为钢（E=210 GPa，ν=0.3）。做静力分析：先粗网格求解，报告最大挠度
> 与最大等效应力，并出 von Mises 云图；然后加密一倍网格做网格无关性验证。

Expected agent flow: `cae_cad_build` (NAMED_FACES: fixed/load) →
`cae_mesh_generate` → `cae_solve_static` → `cae_post_process` → numbers + PNG,
with a second, finer mesh pass for mesh independence.

The four calls below show realistic arguments and trimmed receipts for the
first (coarse) pass. Units are consistent throughout: geometry in mm, forces
in N, stresses in MPa, so deflections come out in mm.

## 1. Build the geometry

```json
{
  "script": "from build123d import Box, Axis\npart = Box(100, 20, 5)\nNAMED_FACES = {\n    \"fixed\": part.faces().filter_by(lambda f: abs(f.center().X + 50) < 1e-6)[0],\n    \"load\": part.faces().filter_by(lambda f: abs(f.center().X - 50) < 1e-6)[0],\n}",
  "name": "beam"
}
```

```json
{
  "stepPath": "/tmp/cae/beam.step",
  "volumeMm3": 10000.0,
  "bboxMm": { "min": [-50.0, -10.0, -2.5], "max": [50.0, 10.0, 2.5] },
  "namedFaces": [
    { "name": "fixed", "areaMm2": 100.0, "centroidMm": [-50.0, 0.0, 0.0] },
    { "name": "load", "areaMm2": 100.0, "centroidMm": [50.0, 0.0, 0.0] }
  ]
}
```

## 2. Mesh it

```json
{ "step": "/tmp/cae/beam.step", "elementSizeMm": 3.0 }
```

```json
{
  "mshPath": "/tmp/cae/beam.msh",
  "nodeCount": 4712,
  "elementCount": 2834,
  "groupNames": ["fixed", "load", "solid"],
  "quality": { "minJacobian": 0.31 }
}
```

## 3. Solve the static case

```json
{
  "msh": "/tmp/cae/beam.msh",
  "material": { "youngMPa": 210000, "poisson": 0.3 },
  "constraints": [ { "groupName": "fixed", "kind": "fixed" } ],
  "loads": [ { "groupName": "load", "vectorN": [0, 0, -100] } ],
  "case": "case"
}
```

```json
{
  "inpPath": "/tmp/cae/case.inp",
  "frdPath": "/tmp/cae/case.frd",
  "vtuPath": "/tmp/cae/case.vtu",
  "exitCode": 0,
  "wallMs": 1840,
  "logTail": "..."
}
```

`exitCode: 0` means the solve converged; a non-zero exit code is a domain
outcome the agent should follow up on via `logTail`.

## 4. Extract numbers and a contour

```json
{
  "vtu": "/tmp/cae/case.vtu",
  "maxima": [ { "field": "displacement" }, { "field": "vonMises" } ],
  "plots": [ { "field": "vonMises" } ]
}
```

```json
{
  "values": [
    { "kind": "max", "field": "displacement", "value": 0.756, "unit": "mm", "atMm": [50.0, 0.0, -0.75] },
    { "kind": "max", "field": "vonMises", "value": 118.4, "unit": "MPa", "atMm": [-50.0, 0.0, 2.2] }
  ],
  "plots": [ { "field": "vonMises", "path": "/tmp/cae/case.vonMises.png" } ]
}
```

## Reading the numbers against theory

Euler–Bernoulli tip deflection for this beam:

δ = PL³ / (3EI) with I = bh³/12 = 20·5³/12 mm⁴ → δ ≈ **0.762 mm**

The coarse-mesh result (0.756 mm, well within 5% of theory) plus a finer-mesh
rerun at `elementSizeMm: 1.5` settling at ~0.76 mm is the acceptance evidence:
the pipeline is answering the physics question the user actually asked.
