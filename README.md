<div align="center">

<img src="assets/logo.svg" alt="Mochi" width="400">

# Mochi (dsh-cae)

**English** | [中文](README.zh.md)

[![ci](https://github.com/DaiYuhangSustc/dsh-cae-plugin/actions/workflows/ci.yml/badge.svg)](https://github.com/DaiYuhangSustc/dsh-cae-plugin/actions/workflows/ci.yml)
[![MIT License](https://img.shields.io/github/license/DaiYuhangSustc/dsh-cae-plugin)](LICENSE)
![commit-activity](https://img.shields.io/github/commit-activity/m/DaiYuhangSustc/dsh-cae-plugin)
![last-commit](https://img.shields.io/github/last-commit/DaiYuhangSustc/dsh-cae-plugin)

</div>

Natural-language-driven CAE pipeline for DeepSeek Harness: the agent takes a plain-language simulation request and drives a complete CAD → mesh → solve → post-process chain over build123d, Gmsh, CalculiX, OpenFOAM, and PyVista.
Six tools cover the chain end to end — geometry construction, tetrahedral meshing, linear static solving, result extraction/plotting, and a parallel CFD chain (blockMesh → steady incompressible solve → post) for internal-flow requests — with receipts (paths, volumes, mesh quality, field extremes) fed back to the model after every stage.

## Install

Python stack first: `pip install build123d gmsh pyvista ccx2paraview`, plus a CalculiX solver — `sudo apt install calculix-ccx` on Debian/Ubuntu or `conda install -c conda-forge calculix` elsewhere (the `ccx` binary must be on PATH).
For the CFD chain, OpenFOAM (Foundation v11–13 or ESI) must be installed; its `etc/bashrc` is auto-detected (`$FOAM_BASHRC`, `/opt/openfoam*`, `/usr/lib/openfoam*`) or set via `openfoamBashrc`.
Then load the plugin into a profile — run `dsh` from a DeepSeek Harness checkout:

- Local checkout (plugin development): `dsh plugin --profile web add /path/to/dsh-cae` — installs as a `link:` dependency; after changing the plugin, `pnpm build` and restart the surface to pick it up.
- Direct git checkout: `dsh plugin --profile web add https://github.com/DaiYuhangSustc/dsh-cae-plugin.git` (git installs run the `prepare` build script; pnpm users may need to allow it via `allowBuilds`).
- npm registry (once published): `dsh plugin --profile web add dsh-cae`.

Each profile holds its own plugin list — repeat the `add` for every profile you use (e.g. `headless`).

## Launch and use

- Browser: `dsh web` boots the web UI on http://127.0.0.1:3080 (`--port` to change; it opens the default browser automatically) — paste a plain-language request and watch the tool calls and receipts stream.
- Terminal: `dsh --profile headless "20×20 mm square duct, 1 m long, water at 0.02 m/s inlet — steady laminar solve and a pressure contour"` runs one task headlessly and prints the transcript.
A surface started before the plugin was added cannot see it — restart the surface after `add` (or after a rebuild, for `link:` installs).

## Try it

See [examples/cantilever.md](examples/cantilever.md): a single Chinese sentence produces a fixed-end cantilever under tip load, solved on coarse and refined meshes with a von Mises contour and a mesh-independence check.
And [examples/duct-flow.md](examples/duct-flow.md): one Chinese sentence produces a laminar duct-flow solution validated against the Shah–London friction constant.

## The six tools

| Tool | Input | Output |
| --- | --- | --- |
| `cae_cad_build` | build123d `script` (defines `part`, optional `NAMED_FACES`) + `name` | `.step` path, volume, bounding box, named faces with areas/centroids |
| `cae_mesh_generate` | `.step` path, `elementSizeMm`, `elementType` (`tet4`/`tet10`) | `.msh` path, node/element counts, quality metrics |
| `cae_solve_static` | `.msh` path, material (`youngMPa`, `poisson`), loads/boundary conditions on named faces | `.frd`/`.vtu` paths, solver log tail, reaction summary |
| `cae_post_process` | `.vtu`/`.frd` path, field/point/plot queries | field extremes with locations, point values, contour PNG paths |
| `cae_cfd_mesh` | duct `lengthMm`/`widthMm`/`heightMm`/`cellSizeMm` (+ `wallGrading`, full `blockMeshDict` text, `name`) | `caseDir` (SI bounds, cell count, checkMesh quality, `checksPassed`) |
| `cae_cfd_steady` | `caseDir`, `inletVelocityMS`, `kinematicViscosityM2S`, `densityKgM3`, `iterations`, dict `overrides` | solver log tail, `converged` + final residuals, VTK path |

## Trust boundary

The `script` parameter is model-generated Python (and batch text) executed locally with trust level equal to the harness's own bash tool; treat it accordingly and use a profile permission layer (tools/pre-execute) for governance.

## Units

Millimeters, newtons, megapascals everywhere: geometry in mm, forces in N, stresses in MPa, so deflections come out in mm and Young's modulus is entered as MPa (steel ≈ 210000).
The CFD chain takes geometry in mm at `cae_cfd_mesh` (converted to m once) and is SI afterwards: m, m/s, Pa, Pa·s; `cae_post_process` converts kinematic pressure to Pa when given `densityKgM3`.

## Configuration

| Field | Default | Meaning |
| --- | --- | --- |
| `python` | `auto` | `'auto'` probes a conda env named `dsh-cae` (`$CONDA_PREFIX`, `$CONDA_ENVS_PATH`, `~/.conda`, `~/miniconda3`, `~/anaconda3`, `~/mambaforge`, `/opt/conda`), falling back to `python3`; or set an explicit interpreter path |
| `workdir` | `./cae` | Artifact directory (relative to agent cwd) for STEP/MSH/INP/FRD/VTU/PNG files |
| `stageTimeoutMs` | `600000` | Per-stage wall-clock budget in ms; exceeded kills the stage process group |
| `openfoamBashrc` | auto-detect | OpenFOAM `etc/bashrc` path; auto-detection checks `$FOAM_BASHRC`, `/opt/openfoam*/etc/bashrc`, `/usr/lib/openfoam/*/etc/bashrc` |

## Troubleshooting

If `import build123d` dies with `pyexpat ... undefined symbol: XML_SetAllocTrackerActivationThreshold`, an inherited `LD_LIBRARY_PATH` (e.g. OpenFOAM's bashrc listing `/usr/lib` dirs) is shadowing the interpreter's own newer libexpat. For a conda-style interpreter — `python: auto` or an explicit env path — the runner already prepends the env's `lib` to `LD_LIBRARY_PATH` and its `bin` to `PATH` at spawn time; for other layouts force the newer one first yourself: `LD_PRELOAD=$CONDA_PREFIX/lib/libexpat.so.1`.
Linux servers without a display need EGL or OSMesa for PyVista rendering — prefer conda's vtk, which ships an OSMesa-capable build via `conda install -c conda-forge vtk osmesa`; CI sets `PYVISTA_OFF_SCREEN=true`, under which vtk renders off-screen without X.
OpenFOAM 11+ (Foundation) replaced standalone solvers: this plugin runs `foamRun` (`solver incompressibleFluid`), the simpleFoam successor; ESI releases keep `simpleFoam` but the invoked names here are Foundation's. `foamToVTK` writes legacy `.vtk`, which `cae_post_process` reads directly.

## Limitations

Structural: linear static analysis only, tetrahedral meshes only; CFD: steady incompressible laminar internal flow only, block-hex meshes only; POSIX only; single-machine.

## Roadmap

CAE skill for prompt guidance, background jobs via `ctx.jobs`, modal/thermal analysis, turbulence (kOmegaSST + y+ treatment), snappyHexMesh/STL geometry, pluggable solver providers.

## Contributing

PRs and issues are welcome — a natural-language CAE stack covers a lot of ground, and it needs many hands: more physics, more solvers, better examples and docs.

Development setup (TS side): `pnpm install`.
Note: `@deepseek-ai/dsh-tools` is at rc.1 and its runtime import chain pulls `dsh-llm`/`dsh-scope`/`dsh-session`/`dsh-timeout`; when installed out-of-tree into a profile, resolution normally comes from the in-profile `dsh-base`.
For a standalone dev checkout, `pnpm install` needs `autoInstallPeers: false` (already in pnpm-workspace.yaml) plus the declared extra devDeps — if peers still fail to resolve, install within a dsh profile rather than standalone.

Kernel environment, no sudo required (the route CI-equivalent validation uses locally):

```sh
conda create -n dsh-cae -c conda-forge python=3.11 calculix -y
conda run -n dsh-cae python -m ensurepip --upgrade
conda run -n dsh-cae pip install build123d gmsh pyvista ccx2paraview pytest
```

The env name matters: the default `python: auto` probes for a conda env named exactly `dsh-cae`, so this env needs no further configuration.

Run the suite that matches your change:

| Layer | Command | Notes |
| --- | --- | --- |
| TS tools / runner | `pnpm build && pnpm vitest run` | keyless, runs everywhere |
| Python stages | `pytest pytest -v` | inside the kernel env; the `pytest/` directory shadows the `pytest` package, so the console script is required — never `python -m pytest` from the repo root |
| Loader composition | `DSH_COMPOSITION=1 pnpm vitest run tests/composition.e2e.ts` | needs a dsh harness checkout; opt-in, CI does not gate it |

Contracts every change must keep:

- The TS layer owns orchestration only (tool schemas, subprocesses, timeouts, receipts); all domain knowledge lives in `python/dsh_cae/`. The layers couple through argv and the stdout receipt line `<<<DSH_CAE_JSON>>>` — nothing else.
- Solver outcomes are data: a non-zero ccx exit is a normal receipt carrying `exitCode` and `logTail` for the model to diagnose; only infrastructure failures (missing binary, timeout, unparseable output) raise.
- Units are mm/N/MPa everywhere, with no conversion anywhere.
- Some solver realities are encoded deliberately, with comments: Gmsh tet10 mid-edge nodes 9/10 are swapped against Abaqus C3D10 in `solve.py`; ccx exits 0 even on a singular (unconstrained) system, so the domain-failure test drives ccx with a `*CLOAD` on a nonexistent node.

PR expectations: the tests covering your layer are green; kernel tests self-skip without kernels — say so in the PR and let CI run them for real; update `README.md` and `README.zh.md` together (the two files mirror each other); conventional commit subjects (`feat:`, `fix:`, `docs:`, `test:`).

Good first targets are the Roadmap items above: a new analysis type (`*FREQUENCY`, `*HEAT TRANSFER`), turbulence and snappyHexMesh extensions on top of the CFD chain, a cae skill teaching the model build123d/INP idioms, and more runnable examples in the style of `examples/cantilever.md`.

## License

MIT
