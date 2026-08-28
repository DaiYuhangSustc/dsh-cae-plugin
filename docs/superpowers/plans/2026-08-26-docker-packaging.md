# Docker Packaging Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let users run all dsh-cae Python stages inside a prebuilt Docker image by setting `python: docker://ghcr.io/daiyuhangsustc/dsh-cae:latest`, with no local conda/apt/OpenFOAM installation.

**Architecture:** Approach A from `docs/specs/2026-08-26-docker-packaging-design.md` — the TS runner keeps orchestrating on the host but spawns `docker run` instead of a local python for every stage. The workdir is mounted same-path (receipts need no path translation), the plugin's own `python/` dir is mounted read-only (image holds only third-party deps, so plugin releases don't rebuild the image). One fat image (structural + OpenFOAM CFD) published to GHCR on `v*` tags with a build-time full-pytest gate.

**Tech Stack:** TypeScript (existing vitest suite, tsc), Docker/BuildKit (bind-mount validation layer), GitHub Actions (docker/build-push-action@v6 → GHCR), micromamba + conda-forge inside ubuntu:24.04.

## Global Constraints

- POSIX only — the plugin already declares this; docker runtime throws a clear error on win32 instead of silently misbehaving.
- Image name (GHCR requires lowercase): `ghcr.io/daiyuhangsustc/dsh-cae`.
- Conda env name inside image: `dsh-cae` (same name as the local-conda route).
- Config surface: NO new config fields. `docker://<image-ref>` is a new legal value of the existing `python` field. `auto` chain stays conda → python3 (never docker).
- Docker branch passes NO host environment into the container except `PATH` for the docker CLI itself (the libexpat lesson: host env pollution must not reach the container).
- Plugin version for first release: `v0.3.0` (package.json `0.2.0` → `0.3.0`).
- Test commands: TS side `pnpm vitest run <file>`; full suites must stay green (`28 passed | 2 skipped` vitest baseline before this plan's additions, 50 pytest — python side is untouched by this plan).
- Commit messages match repo style (`feat:`, `ci:`, `docs:` prefixes, lowercase).

---

### Task 1: `parseRuntime` + `runtimeFor` in interpreter.ts

**Files:**
- Modify: `src/interpreter.ts`
- Test: `tests/interpreter.test.ts`

**Interfaces:**
- Consumes: existing `pythonFor(config)` (memoized local resolution).
- Produces: `export type Runtime = { kind: 'local', command: string } | { kind: 'docker', image: string }`; `parseRuntime(python: string): Runtime`; `runtimeFor(config: { python: string }): Runtime`. Later tasks rely on these exact names.

- [ ] **Step 1: Write the failing tests**

Append to `tests/interpreter.test.ts` (inside a new describe block; add `parseRuntime` to the import list from `'../src/interpreter.ts'`):

```ts
describe('parseRuntime', () => {
  it('passes any non-docker value through as a local command', () => {
    expect(parseRuntime('python3')).toEqual({ kind: 'local', command: 'python3' })
    expect(parseRuntime('/opt/envs/dsh-cae/bin/python'))
      .toEqual({ kind: 'local', command: '/opt/envs/dsh-cae/bin/python' })
  })

  it('extracts the image from a docker:// value', () => {
    expect(parseRuntime('docker://ghcr.io/daiyuhangsustc/dsh-cae:latest'))
      .toEqual({ kind: 'docker', image: 'ghcr.io/daiyuhangsustc/dsh-cae:latest' })
  })

  it('rejects docker:// with an empty image and shows a config example', () => {
    expect(() => parseRuntime('docker://')).toThrow(/image reference.*docker:\/\/ghcr\.io/)
  })
})
```

- [ ] **Step 2: Run to verify RED**

Run: `pnpm vitest run tests/interpreter.test.ts`
Expected: FAIL — `parseRuntime` is not exported (import error / undefined).

- [ ] **Step 3: Implement in `src/interpreter.ts`**

Add below the `AUTO_PYTHON` const (nothing else changes):

```ts
/** Resolved execution runtime for a Python stage: local interpreter or container. */
export type Runtime = { kind: 'local', command: string } | { kind: 'docker', image: string }

/**
 * Parse the `python` config value into a runtime. `docker://<image-ref>` selects
 * the container runtime; anything else is a local interpreter command/path.
 * @param python - the `python` config value.
 * @returns local command or docker image reference to run stages with.
 */
export function parseRuntime(python: string): Runtime {
  if (!python.startsWith('docker://')) return { kind: 'local', command: python }
  const image = python.slice('docker://'.length).trim()
  if (image === '') {
    throw new Error(
      "python: 'docker://' requires an image reference, "
      + 'e.g. docker://ghcr.io/daiyuhangsustc/dsh-cae:latest',
    )
  }
  return { kind: 'docker', image }
}

/**
 * Resolve the stage runtime for a config object: docker stays as configured,
 * local goes through the memoized interpreter resolution.
 * @param config - deployment configuration.
 * @returns runtime used by runStage.
 */
export function runtimeFor(config: { python: string }): Runtime {
  const rt = parseRuntime(config.python)
  return rt.kind === 'local' ? { kind: 'local', command: pythonFor(config) } : rt
}
```

- [ ] **Step 4: Run to verify GREEN**

Run: `pnpm vitest run tests/interpreter.test.ts`
Expected: PASS (all existing tests + 3 new).

- [ ] **Step 5: Commit**

```bash
git add src/interpreter.ts tests/interpreter.test.ts
git commit -m "feat: parse docker:// runtime from the python config field"
```

---

### Task 2: `dockerArgv` + `dockerSpawnEnv` in interpreter.ts

**Files:**
- Modify: `src/interpreter.ts`
- Test: `tests/interpreter.test.ts`

**Interfaces:**
- Consumes: `pythonDir()` from Task-0 (already exists in this module); `process.getuid/getgid`.
- Produces: `dockerArgv(image: string, workdir: string, stage: string, args: string[]): string[]` (full argv including `docker`), `dockerSpawnEnv(parent: NodeJS.ProcessEnv): NodeJS.ProcessEnv` (only `PATH` passes through). Task 4 consumes both.

- [ ] **Step 1: Write the failing tests**

Append (add `dockerArgv`, `dockerSpawnEnv` to imports):

```ts
describe('dockerArgv', () => {
  it('builds a same-path-mount, read-only-plugin-mount docker run argv', () => {
    const argv = dockerArgv('img:tag', '/tmp/w', 'fixtures.fake_stage', ['--mode', 'ok'])
    expect(argv.slice(0, 3)).toEqual(['docker', 'run', '--rm'])
    expect(argv).toContain('--init')
    expect(argv).toContain('/tmp/w:/tmp/w')
    expect(argv).toContain(`${pythonDir()}:/opt/dsh-cae/python:ro`)
    const w = argv.indexOf('-w')
    expect(argv[w + 1]).toBe('/tmp/w')
    const u = argv.indexOf('-u')
    expect(argv[u + 1]).toMatch(/^\d+:\d+$/)
    expect(argv).toContain('img:tag')
    expect(argv.slice(-5)).toEqual(['python', '-m', 'dsh_cae.fixtures.fake_stage', '--mode', 'ok'])
  })
})

describe('dockerSpawnEnv', () => {
  it('passes only PATH through to the docker CLI', () => {
    const env = dockerSpawnEnv({ PATH: '/usr/bin', LD_LIBRARY_PATH: '/opt/openfoam/evil', HOME: '/home/u' })
    expect(env).toEqual({ PATH: '/usr/bin' })
  })
})
```

- [ ] **Step 2: Run to verify RED**

Run: `pnpm vitest run tests/interpreter.test.ts`
Expected: FAIL — neither function is exported.

- [ ] **Step 3: Implement in `src/interpreter.ts`**

Add below `stageEnv`:

```ts
/**
 * Build the full `docker run` argv for one stage. The workdir is mounted
 * same-path so receipt paths are identical on host and container; the plugin's
 * own `python/` dir is mounted read-only so the image never ships `dsh_cae`.
 * @param image - container image reference.
 * @param workdir - absolute stage workdir (host == container path).
 * @param stage - module path under `dsh_cae`, e.g. `'cad'`.
 * @param args - CLI arguments forwarded after the module name.
 * @returns complete argv (element 0 is `docker`).
 */
export function dockerArgv(image: string, workdir: string, stage: string, args: string[]): string[] {
  if (process.platform === 'win32') {
    throw new Error('dsh-cae docker runtime requires a POSIX host (the plugin is POSIX-only)')
  }
  const uid = process.getuid?.() ?? 1000
  const gid = process.getgid?.() ?? 1000
  return [
    'docker', 'run', '--rm', '--init',
    '-v', `${workdir}:${workdir}`,
    '-v', `${pythonDir()}:/opt/dsh-cae/python:ro`,
    '-w', workdir,
    '-u', `${uid}:${gid}`,
    '-e', 'HOME=/tmp',
    '-e', 'PYTHONPATH=/opt/dsh-cae/python',
    image, 'python', '-m', `dsh_cae.${stage}`, ...args,
  ]
}

/**
 * Environment for the docker CLI process itself. Deliberately minimal: only
 * PATH passes. Host LD_LIBRARY_PATH & co. must never influence the container
 * (the drill-bit case spent hours on exactly that class of pollution).
 * @param parent - environment to filter.
 * @returns environment containing only PATH.
 */
export function dockerSpawnEnv(parent: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return { PATH: parent.PATH }
}
```

- [ ] **Step 4: Run to verify GREEN**

Run: `pnpm vitest run tests/interpreter.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/interpreter.ts tests/interpreter.test.ts
git commit -m "feat: docker run argv builder with same-path mount and env whitelist"
```

---

### Task 3: `dockerPreflight` in interpreter.ts

**Files:**
- Modify: `src/interpreter.ts`
- Test: `tests/interpreter.test.ts`

**Interfaces:**
- Consumes: `node:child_process` `spawnSync`.
- Produces: `dockerPreflight(image: string, config: object, opts?: { dockerBin?: string }): Promise<void>` — resolves after CLI+daemon verified and image present locally (auto-pulls when missing); rejects with an actionable message. Memoized per config object on success only. Task 4 awaits this.

- [ ] **Step 1: Write the failing test**

Append (add `dockerPreflight` to imports):

```ts
describe('dockerPreflight', () => {
  it('reports Docker as not installed when the binary is missing', async () => {
    await expect(dockerPreflight('img:tag', {}, { dockerBin: '/nonexistent/docker-bin' }))
      .rejects.toThrow(/Docker is not installed.*docs\.docker\.com/)
  })
})
```

- [ ] **Step 2: Run to verify RED**

Run: `pnpm vitest run tests/interpreter.test.ts`
Expected: FAIL — `dockerPreflight` not exported.

- [ ] **Step 3: Implement in `src/interpreter.ts`**

Add `spawnSync` to the existing `node:child_process`… there is none yet, so add a new import at the top:

```ts
import { spawnSync } from 'node:child_process'
```

Then below `runtimeFor`:

```ts
/** Preflight verdicts memoized per config; only successful probes are cached. */
const preflightOk = new WeakMap<object, Promise<void>>()

/**
 * Verify docker is usable and the image exists locally, auto-pulling when it
 * does not (pull is not bound by stageTimeoutMs — first-use experience).
 * @param image - container image reference.
 * @param config - deployment configuration (memoization key).
 * @param opts - dockerBin override for tests.
 */
export async function dockerPreflight(
  image: string,
  config: object,
  opts: { dockerBin?: string } = {},
): Promise<void> {
  const cached = preflightOk.get(config)
  if (cached) return cached
  const bin = opts.dockerBin ?? 'docker'
  const probe = (args: string[]) => spawnSync(bin, args, { encoding: 'utf8' })
  const check = (async () => {
    if (probe(['--version']).error) {
      throw new Error('dsh-cae docker runtime: Docker is not installed — https://docs.docker.com/get-docker/')
    }
    if (probe(['info']).status !== 0) {
      throw new Error(
        'dsh-cae docker runtime: Docker daemon is not running — start it '
        + '(e.g. `sudo systemctl start docker`) and retry',
      )
    }
    if (probe(['image', 'inspect', image]).status !== 0) {
      const pull = probe(['pull', image])
      if (pull.status !== 0) {
        throw new Error(
          `dsh-cae docker runtime: failed to pull ${image} — run \`docker pull ${image}\` manually\n`
          + (pull.stderr || '').slice(-2000),
        )
      }
    }
  })()
  preflightOk.set(config, check)
  check.catch(() => preflightOk.delete(config)) // retry on next call after a failure
  return check
}
```

- [ ] **Step 4: Run to verify GREEN**

Run: `pnpm vitest run tests/interpreter.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/interpreter.ts tests/interpreter.test.ts
git commit -m "feat: docker preflight with daemon check and auto-pull"
```

---

### Task 4: Wire the docker runtime into runner.ts

**Files:**
- Modify: `src/runner.ts` (the `runStage` spawn block, ~lines 52–61)

**Interfaces:**
- Consumes: `runtimeFor`, `dockerArgv`, `dockerSpawnEnv`, `dockerPreflight` from `src/interpreter.ts`.
- Produces: `runStage` transparently executing stages in the container when configured. No signature change.

- [ ] **Step 1: Extend the interpreter import line**

In `src/runner.ts` replace:

```ts
import { INSTALL_HINTS, depsFailureMessage, pythonFor, stageEnv } from './interpreter.js'
```

with:

```ts
import {
  INSTALL_HINTS, dockerArgv, dockerPreflight, dockerSpawnEnv, depsFailureMessage, pythonFor, runtimeFor, stageEnv,
} from './interpreter.js'
```

- [ ] **Step 2: Branch the spawn in `runStage`**

Replace the spawn block:

```ts
  const python = pythonFor(config)
  const proc = spawn(python, ['-m', `dsh_cae.${stage}`, ...args], {
    cwd: workdir,
    detached: true,
    env: stageEnv(python, process.env),
    stdio: ['ignore', 'pipe', 'pipe'],
  })
```

with:

```ts
  const runtime = runtimeFor(config)
  if (runtime.kind === 'docker') await dockerPreflight(runtime.image, config)
  const argv = runtime.kind === 'docker'
    ? dockerArgv(runtime.image, workdir, stage, args)
    : [runtime.command, '-m', `dsh_cae.${stage}`, ...args]
  const env = runtime.kind === 'docker'
    ? dockerSpawnEnv(process.env)
    : stageEnv(runtime.command, process.env)
  const proc = spawn(argv[0], argv.slice(1), {
    cwd: workdir,
    detached: true,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
```

- [ ] **Step 3: Verify no regressions**

Run: `pnpm vitest run && npx tsc -p tsconfig.json`
Expected: all previously passing tests still pass (every existing test config uses a local python), build clean.

- [ ] **Step 4: Commit**

```bash
git add src/runner.ts
git commit -m "feat: runStage executes stages via docker when python is docker://"
```

---

### Task 5: Dockerfile + .dockerignore, image builds green

**Files:**
- Create: `docker/Dockerfile`
- Create: `.dockerignore`

**Interfaces:**
- Consumes: repo `python/` and `pytest/` (bind-mounted at build time only — nothing persists into the image).
- Produces: image containing micromamba env `dsh-cae`, `ccx`, OpenFOAM 13 at `/opt/openfoam13`, `PYVISTA_OFF_SCREEN=true`; `pytest` on PATH. Task 6's e2e and the CI workflow build this exact file.

- [ ] **Step 1: Write `.dockerignore` (context = only what the build gate needs)**

```
*
!python/
!pytest/
```

- [ ] **Step 2: Write `docker/Dockerfile`**

```dockerfile
# syntax=docker/dockerfile:1.7
# dsh-cae stage runtime: everything the Python stages need, nothing else.
# Build from the repo root:  docker build -f docker/Dockerfile -t dsh-cae-e2e:dev .

FROM ubuntu:24.04

ENV DEBIAN_FRONTEND=noninteractive LANG=C.UTF-8

RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates curl wget xz-utils bzip2 git gpg software-properties-common \
    && rm -rf /var/lib/apt/lists/*

# OpenFOAM Foundation 13 (official openfoam.org apt repo) -> /opt/openfoam13,
# where the python-side bashrc auto-detection already looks.
RUN wget -qO- https://dl.openfoam.org/gpg.key | gpg --dearmor > /etc/apt/trusted.gpg.d/openfoam.gpg \
    && add-apt-repository -y "http://dl.openfoam.org/ubuntu" \
    && apt-get update && apt-get install -y --no-install-recommends openfoam13 \
    && rm -rf /var/lib/apt/lists/*

# micromamba env mirroring the local-conda route (same env name: dsh-cae).
ENV MAMBA_ROOT_PREFIX=/opt/mamba
RUN curl -Ls https://micro.mamba.pm/api/micromamba/linux-64/latest \
      | tar -xj -C /usr/local --strip-components=1 bin/micromamba \
    && micromamba create -y -n dsh-cae -c conda-forge \
         python=3.11 build123d gmsh pyvista ccx2paraview vtk osmesa calculix pytest \
    && micromamba clean -y --all

ENV PATH=/opt/mamba/envs/dsh-cae/bin:$PATH \
    PYVISTA_OFF_SCREEN=true

# Build-time gate: the full pytest suite must pass inside this image.
# bind mounts keep the validation copy out of the final layers (the image never
# ships dsh_cae — the runner mounts the plugin's python/ at run time).
RUN --mount=type=bind,source=python,target=/tmp/validate/python \
    --mount=type=bind,source=pytest,target=/tmp/validate/pytest \
    cd /tmp/validate && PYTHONPATH=/tmp/validate/python pytest pytest -q
```

- [ ] **Step 3: Build locally and watch the gate run**

Run: `docker build -f docker/Dockerfile -t dsh-cae-e2e:dev .` (from repo root; 20–40 min first time)
Expected: final layer prints `50 passed`; image tagged `dsh-cae-e2e:dev`.
If openfoam.org apt repo or conda-forge solve fails, fix pins in place (e.g. pin `openfoam13` to whatever `apt-cache search openfoam` shows in the image) — do not remove the pytest gate.

- [ ] **Step 4: Commit**

```bash
git add docker/Dockerfile .dockerignore
git commit -m "feat: stage-runtime image with build-time pytest gate"
```

---

### Task 6: Opt-in docker e2e tests

**Files:**
- Create: `tests/docker.e2e.ts`

**Interfaces:**
- Consumes: `runStage` (docker branch from Task 4), image `dsh-cae-e2e:dev` (Task 5).
- Produces: e2e proof of the docker runtime; skipped unless `DSH_CAE_DOCKER_E2E=1`.

- [ ] **Step 1: Write the tests**

```ts
// tests/docker.e2e.ts — opt-in: needs a locally built dsh-cae-e2e:dev image.
// Gate: DSH_CAE_DOCKER_E2E=1 (same opt-in pattern as composition.e2e).
import { describe, expect, it, beforeAll, afterAll } from 'vitest'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runStage } from '../src/runner.ts'
import type { Config } from '../src/config.ts'

const enabled = process.env.DSH_CAE_DOCKER_E2E === '1'

describe.skipIf(!enabled)('docker runtime e2e', () => {
  let work: string
  let config: Config
  beforeAll(async () => {
    work = await mkdtemp(join(tmpdir(), 'dsh-cae-docker-'))
    config = { python: 'docker://dsh-cae-e2e:dev', workdir: work, stageTimeoutMs: 120_000 }
  })
  afterAll(async () => { await rm(work, { recursive: true, force: true }) })

  it('runs the deps check inside the container and reports ok with diagnostics', async () => {
    const { receipt } = await runStage(config, 'deps', ['--group', 'structural'], { logFile: 'deps.log' })
    expect(receipt.ok).toBe(true)
    expect((receipt.diagnostics as { python?: string }).python).toContain('python')
  })

  it('runs a stage through the same-path workdir mount and writes host-visible artifacts', async () => {
    const res = await runStage(config, 'fixtures.fake_stage', ['--mode', 'ok'], { logFile: 'fake.log' })
    expect(res.receipt).toEqual({ ok: true, value: 42 })
    const log = await readFile(join(work, 'fake.log'), 'utf8')
    expect(log).toContain('noise line before receipt')
  })
})
```

- [ ] **Step 2: Run with the gate off — suite stays green**

Run: `pnpm vitest run`
Expected: new file skipped; previous totals unchanged (`… passed | … skipped` grows by 2 skipped).

- [ ] **Step 3: Run with the gate on (image from Task 5 present)**

Run: `DSH_CAE_DOCKER_E2E=1 pnpm vitest run tests/docker.e2e.ts`
Expected: 2 passed.

- [ ] **Step 4: Commit**

```bash
git add tests/docker.e2e.ts
git commit -m "test: opt-in docker runtime e2e against a locally built image"
```

---

### Task 7: GHCR publishing workflow

**Files:**
- Create: `.github/workflows/docker.yml`

**Interfaces:**
- Consumes: `docker/Dockerfile` from Task 5; repo tags `v*`.
- Produces: `ghcr.io/daiyuhangsustc/dsh-cae:{version, major.minor, latest}` on every `v*` tag.

- [ ] **Step 1: Write the workflow**

```yaml
name: docker

on:
  push:
    tags: ['v*']
  workflow_dispatch:

permissions:
  contents: read
  packages: write

jobs:
  build-push:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: docker/setup-buildx-action@v3
      - uses: docker/login-action@v3
        with:
          registry: ghcr.io
          username: ${{ github.actor }}
          password: ${{ secrets.GITHUB_TOKEN }}
      - id: meta
        uses: docker/metadata-action@v5
        with:
          images: ghcr.io/daiyuhangsustc/dsh-cae
          tags: |
            type=semver,pattern={{version}}
            type=semver,pattern={{major}}.{{minor}}
            type=raw,value=latest
      - uses: docker/build-push-action@v6
        with:
          context: .
          file: docker/Dockerfile
          push: true
          tags: ${{ steps.meta.outputs.tags }}
          labels: ${{ steps.meta.outputs.labels }}
          cache-from: type=gha
          cache-to: type=gha,mode=max
```

- [ ] **Step 2: Sanity-check the YAML**

Run: `python3 -c "import yaml,sys; yaml.safe_load(open('.github/workflows/docker.yml')); print('YAML_OK')"`
Expected: `YAML_OK`.

- [ ] **Step 3: Commit**

```bash
git add .github/workflows/docker.yml
git commit -m "ci: publish the stage-runtime image to GHCR on v* tags"
```

---

### Task 8: READMEs — docker install route, config, troubleshooting

**Files:**
- Modify: `README.md` (Install section ~line 23, config table ~line 66, Troubleshooting ~line 71)
- Modify: `README.zh.md` (same three sections)

**Interfaces:**
- Consumes: shipped image `ghcr.io/daiyuhangsustc/dsh-cae:latest`.
- Produces: documented install routes; no code.

- [ ] **Step 1: README.md — prepend the Docker route to `## Install`**

Insert immediately after the `## Install` heading, before the existing "Python stack first:" paragraph:

```markdown
Recommended (Docker): install Docker, add the plugin, and point `python` at the prebuilt image — no conda, no apt CalculiX, no OpenFOAM install. The image is pulled automatically on first use (~3–4 GB):

```yaml
python: docker://ghcr.io/daiyuhangsustc/dsh-cae:latest
```

Local interpreter (no Docker): the routes below.
```

Keep every existing local-install paragraph unchanged after that line.

- [ ] **Step 2: README.md — config table row**

Replace the `python` row (currently ending in `falling back to \`python3\`; or set an explicit interpreter path |`) with:

```markdown
| `python` | `auto` | `'auto'` probes a conda env named `dsh-cae` (`$CONDA_PREFIX`, `$CONDA_ENVS_PATH`, `~/.conda`, `~/miniconda3`, `~/anaconda3`, `~/mambaforge`, `/opt/conda`), falling back to `python3`; or set an explicit interpreter path; or `docker://<image-ref>` to run every stage in a container — recommended image `ghcr.io/daiyuhangsustc/dsh-cae` (auto-pulled on first use) |
```

- [ ] **Step 3: README.md — Troubleshooting additions**

Append to `## Troubleshooting`:

```markdown
Docker route errors are explicit: "Docker is not installed" → install Docker; "daemon is not running" → `sudo systemctl start docker`; "failed to pull" → run the printed `docker pull` by hand. A stale image behaves like stale dependencies — `docker pull ghcr.io/daiyuhangsustc/dsh-cae:latest` to refresh.
```

- [ ] **Step 4: Apply the same three edits to `README.zh.md` in Chinese**

Docker 路线段（插在 `## 安装` 标题之后、"先装 Python 栈"段落之前）：

```markdown
推荐（Docker）：装好 Docker、添加插件、把 `python` 指向预构建镜像——不需要 conda、apt 装 CalculiX、也不需要装 OpenFOAM。镜像在首次使用时自动拉取（约 3–4 GB）：

```yaml
python: docker://ghcr.io/daiyuhangsustc/dsh-cae:latest
```

本地解释器（无 Docker）：见下方路线。
```

配置表 `python` 行（当前以"也可显式指定解释器路径 |"结尾）替换为：

```markdown
| `python` | `auto` | `'auto'` 自动探测名为 `dsh-cae` 的 conda 环境（`$CONDA_PREFIX`、`$CONDA_ENVS_PATH`、`~/.conda`、`~/miniconda3`、`~/anaconda3`、`~/mambaforge`、`/opt/conda`），找不到再回退 `python3`；也可显式指定解释器路径；或 `docker://<镜像引用>` 让所有阶段在容器中运行——推荐镜像 `ghcr.io/daiyuhangsustc/dsh-cae`（首次使用自动拉取） |
```

故障排查段末尾追加：

```markdown
Docker 路线的报错都是显式的："Docker is not installed" → 安装 Docker；"daemon is not running" → `sudo systemctl start docker`；"failed to pull" → 按提示手动执行 `docker pull`。镜像过期表现得像依赖过期——`docker pull ghcr.io/daiyuhangsustc/dsh-cae:latest` 刷新即可。
```

- [ ] **Step 5: Verify and commit**

Run: `git diff --stat` — expect only the two READMEs.
```bash
git add README.md README.zh.md
git commit -m "docs: docker install route for both READMEs"
```

---

### Task 9: Version bump to 0.3.0

**Files:**
- Modify: `package.json` (`"version": "0.2.0"` → `"0.3.0"`)

- [ ] **Step 1: Bump and verify**

Run: `jq '.version = "0.3.0"' package.json > /tmp/pkg.json && mv /tmp/pkg.json package.json && jq .version package.json`
Expected: `"0.3.0"`.

- [ ] **Step 2: Full suite still green**

Run: `pnpm vitest run && npx tsc -p tsconfig.json`
Expected: all green.

- [ ] **Step 3: Commit**

```bash
git add package.json
git commit -m "chore: v0.3.0 — docker runtime, image publishing"
```

Release note (manual, after this plan): tag `v0.3.0` and push it — the workflow from Task 7 publishes the first image; then the README quickstart link becomes live.
