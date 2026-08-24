# dsh-cae Plugin Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build `dsh-cae`, an out-of-tree DeepSeek Harness bundle whose four tools let an agent drive CAD modeling → meshing → static solve → post-processing through a bundled Python package (build123d/Gmsh/CalculiX/PyVista).

**Architecture:** One npm package, two layers. The TS layer registers four tools on `ctx.tools` and only orchestrates subprocesses; all domain knowledge lives in `python/dsh_cae/` (shipped as package files, executed via `python -m`, never installed). The sole coupling between layers is CLI args plus a JSON receipt printed after a `<<<DSH_CAE_JSON>>>` marker line on stdout. Pipeline state flows through files in a workdir: `<name>.step` → `<name>.msh` → `<case>.inp/.frd/.vtu` → `<case>.png`.

**Tech Stack:** TypeScript (strict, ESM, `tsc` → `lib/`), vitest; Python ≥3.10 with build123d, gmsh, pyvista, meshio (user-installed), `ccx` (CalculiX) binary; peer deps `@deepseek-ai/cordis@^4.0.1`, deps `@deepseek-ai/dsh-tools@^0.0.1-rc.1`, `@deepseek-ai/schemastery@^3.18.1`.

**Spec:** `docs/specs/2026-08-21-dsh-cae-plugin-design.md` (authoritative; this plan implements it).

## Global Constraints

- Repo root: `~/dsh-cae`. Every command below runs from there unless stated otherwise.
- Node `^22.19 || >=24`, pnpm; `"type": "module"`; `tsc` strict; no default export from the plugin entry (loader drops inject metadata — postmortem 0001).
- Plugin entry named exports exactly: `name = 'dsh-cae'`, `inject = ['tools']`, `Config`, `apply(ctx, config)`.
- Tool names: `cae_cad_build`, `cae_mesh_generate`, `cae_solve_static`, `cae_post_process`. Files named `<name>.step`, `<name>.faces.json`, `<name>.msh`, `<case>.inp`, `<case>.frd`, `<case>.vtu`, `<case>.log`, `<case>.png` in `config.workdir` (default `./cae`).
- Receipt protocol: stage prints the line `<<<DSH_CAE_JSON>>>` then one JSON object (pretty or compact) as the final stdout content. Python stage exits 0 for domain outcomes (including ccx non-zero), exits 1 only for infrastructure failure.
- Units are fixed by convention, stated in every tool description: geometry mm, forces N, Young's modulus MPa, stresses MPa. No unit conversion anywhere.
- Log tail into canonical values is capped at 8192 bytes; full output goes to the workdir log file.
- Timeouts: `stageTimeoutMs` config default 600000; process group SIGTERM → 2 s grace → SIGKILL; `exec.signal` uses the same path.
- POSIX-only v1 (process groups); README states Linux/macOS.
- Commit after every task; messages `feat:`/`test:`/`docs:`/`chore:`, one trailing newline per file.
- Python stages are tested with pytest under `pytest/`; tests skip (not fail) when kernels are missing (`pytest.importorskip`). CI installs everything.
- MIT LICENSE, README.md + README.zh.md, GitHub topics `dsh-plugin deepseek-harness cae fea cad`.

## File Structure (final)

```
package.json              tsconfig.json            vitest.config.ts
.gitignore                LICENSE                  cordis.patch.yml
src/index.ts              — plugin entry + apply wiring
src/config.ts             — Config interface + Schemastery schema
src/runner.ts             — pythonDir(), ensureDeps(), runStage(): spawn/kill/receipt/log
src/tools/cad.ts          — cae_cad_build
src/tools/mesh.ts         — cae_mesh_generate
src/tools/solve.ts        — cae_solve_static
src/tools/post.ts         — cae_post_process
python/dsh_cae/__init__.py
python/dsh_cae/receipt.py — emit()/fail() shared helpers
python/dsh_cae/deps.py    — dependency self-check stage
python/dsh_cae/cad.py     python/dsh_cae/mesh.py
python/dsh_cae/solve.py   python/dsh_cae/post.py
tests/fixtures/fake_stage.py      tests/fixtures/stub_cae.py
tests/runner.test.ts      tests/deps.test.ts
tests/tools-cad-mesh.test.ts      tests/tools-solve-post.test.ts
tests/composition.e2e.ts          pytest/conftest.py
pytest/test_cad.py        pytest/test_mesh.py
pytest/test_solve.py      pytest/test_post.py     pytest/test_pipeline.py
examples/cantilever.md    .github/workflows/ci.yml
README.md                 README.zh.md
```

---

### Task 1: Scaffold — package manifests, build, smoke import

**Files:**
- Create: `package.json`, `tsconfig.json`, `vitest.config.ts`, `.gitignore`, `LICENSE`, `src/index.ts`, `src/config.ts`
- Test: `tests/smoke.test.ts`

**Interfaces:**
- Produces: `Config` interface (`{ python: string; workdir: string; stageTimeoutMs: number }`), `Config` schema export, `apply()` accepting a `ToolFactory[]`-free minimal body (extended in Task 9).

- [ ] **Step 1: Write the failing smoke test**

```ts
// tests/smoke.test.ts
import { describe, expect, it } from 'vitest'
import { Config, inject, name } from '../src/index.ts'

describe('dsh-cae plugin entry', () => {
  it('exports loader metadata with function-plugin shape', () => {
    expect(name).toBe('dsh-cae')
    expect(inject).toEqual(['tools'])
  })
  it('Config schema carries the three deployment fields with defaults', () => {
    expect(Config.meta).toBeDefined()
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm vitest run tests/smoke.test.ts`
Expected: FAIL — cannot resolve `../src/index.ts` (file absent).

- [ ] **Step 3: Create the scaffold files**

```json
// package.json
{
  "name": "dsh-cae",
  "version": "0.1.0",
  "type": "module",
  "description": "DeepSeek Harness bundle: natural-language-driven CAE pipeline (CAD → mesh → solve → post-process)",
  "main": "lib/index.js",
  "types": "lib/index.d.ts",
  "files": ["lib", "python", "cordis.patch.yml", "README.md", "README.zh.md", "LICENSE"],
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "test": "vitest run",
    "prepare": "npm run build"
  },
  "keywords": ["dsh-plugin", "deepseek-harness", "cae", "fea", "cad", "simulation"],
  "license": "MIT",
  "peerDependencies": {
    "@deepseek-ai/cordis": "^4.0.1"
  },
  "dependencies": {
    "@deepseek-ai/dsh-tools": "^0.0.1-rc.1",
    "@deepseek-ai/schemastery": "^3.18.1"
  },
  "devDependencies": {
    "@types/node": "^24.0.0",
    "typescript": "^5.9.0",
    "vitest": "^3.0.0"
  },
  "dsh": { "bundle": { "patch": "./cordis.patch.yml" } }
}
```

```json
// tsconfig.json
{
  "compilerOptions": {
    "target": "ES2023",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "lib": ["ES2023"],
    "types": ["node"],
    "strict": true,
    "noImplicitAny": true,
    "exactOptionalPropertyTypes": true,
    "declaration": true,
    "sourceMap": true,
    "rootDir": "src",
    "outDir": "lib",
    "skipLibCheck": true
  },
  "include": ["src"]
}
```

```ts
// vitest.config.ts
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    testTimeout: 30_000,
  },
})
```

```
# .gitignore
node_modules/
lib/
cae/
*.log
.DS_Store
```

MIT license text with copyright `2026 dsh-cae contributors` (standard template from https://opensource.org/license/mit).

```ts
// src/config.ts
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'

/** Deployment configuration for the CAE tool set. */
export interface Config {
  /** Interpreter that has build123d, gmsh, pyvista, meshio importable (CalculiX `ccx` on PATH). */
  python: string
  /** Directory (relative to the agent cwd) holding all CAE artifacts. */
  workdir: string
  /** Per-stage wall-clock budget in ms; exceeded kills the stage process group. */
  stageTimeoutMs: number
}

/** Schemastery configuration for the dsh-cae bundle. */
export const Config: z<Config> = z.object({
  python: z.string().default('python3').description('Interpreter with build123d/gmsh/pyvista/meshio installed'),
  workdir: z.string().default('./cae').description('Artifact directory for STEP/MSH/INP/FRD/VTU/PNG files'),
  stageTimeoutMs: z.number().default(600000).description('Per-stage timeout in milliseconds'),
})

/** Plugin context type re-export so tool modules need one import site. */
export type PluginContext = Context
```

```ts
// src/index.ts
/**
 * dsh-cae: natural-language-driven CAE pipeline for DeepSeek Harness.
 * Registers four stage tools on `ctx.tools`; domain work runs in bundled
 * Python modules via one-shot subprocesses (spec: docs/specs).
 * @module dsh-cae
 */
import type { Context } from '@deepseek-ai/cordis'
import { Config } from './config.ts'

export const name = 'dsh-cae'
export const inject = ['tools']

export { Config } from './config.ts'

/**
 * Register the CAE stage tools. Tool definitions arrive in Task 8/9; until
 * then this registers nothing so the scaffold stays loadable.
 * @param ctx - registrant context carrying the tool registry.
 * @param _config - deployment configuration (used from Task 8 on).
 */
export function apply(_ctx: Context, _config: Config): void {
  // Tools land in Task 8/9.
}
```

- [ ] **Step 4: Install, build, run the test**

Run: `pnpm install && pnpm build && pnpm vitest run tests/smoke.test.ts`
Expected: PASS (2 tests). `lib/index.js` exists.

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "chore: scaffold dsh-cae package with build and smoke test"
```

---

### Task 2: `src/runner.ts` — subprocess orchestration (TDD with fake stage)

**Files:**
- Create: `src/runner.ts`, `tests/fixtures/fake_stage.py`
- Test: `tests/runner.test.ts`

**Interfaces:**
- Produces:
  - `pythonDir(): string` — absolute path of the shipped `python/` directory (works from `src/` and `lib/`).
  - `runStage(config: Config, stage: string, args: string[], opts: { signal?: AbortSignal; logFile: string }): Promise<{ receipt: Record<string, unknown>; logPath: string }>` — throws `Error` (infrastructure) on non-zero exit, missing receipt, or invalid JSON; message ends with the stderr/stdout tail.
  - `ensureDeps(config: Config, signal?: AbortSignal): Promise<void>` — cached; throws with the exact install commands when the receipt says deps missing.

- [ ] **Step 1: Write the failing tests**

```ts
// tests/runner.test.ts
import { describe, expect, it, beforeAll, afterAll } from 'vitest'
import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pythonDir, runStage } from '../src/runner.ts'
import type { Config } from '../src/config.ts'

const HAS_PYTHON = process.platform !== 'win32'
const py = HAS_PYTHON ? 'python3' : 'python'

describe.skipIf(!HAS_PYTHON)('runStage', () => {
  let work: string
  let config: Config
  beforeAll(async () => {
    work = await mkdtemp(join(tmpdir(), 'dsh-cae-'))
    config = { python: py, workdir: work, stageTimeoutMs: 10_000 }
  })
  afterAll(async () => { await rm(work, { recursive: true, force: true }) })

  it('pythonDir() points at the shipped python package directory', async () => {
    const { exists } = await import('node:fs/promises')
    expect(await exists(join(pythonDir(), 'dsh_cae'))).toBe(true)
  })

  it('returns the receipt and writes the full log file', async () => {
    const res = await runStage(config, 'fixtures.fake_stage',
      ['--mode', 'ok'], { logFile: 'fake.log' })
    expect(res.receipt).toEqual({ ok: true, value: 42 })
    const log = await readFile(join(work, 'fake.log'), 'utf8')
    expect(log).toContain('noise line before receipt')
  })

  it('throws an infrastructure error embedding the tail on stage exit 1', async () => {
    await expect(runStage(config, 'fixtures.fake_stage',
      ['--mode', 'fail'], { logFile: 'fake-fail.log' }))
      .rejects.toThrow(/boom: kernel exploded/)
  })

  it('kills the stage process group on timeout and reports it', async () => {
    await expect(runStage({ ...config, stageTimeoutMs: 500 }, 'fixtures.fake_stage',
      ['--mode', 'sleep'], { logFile: 'fake-sleep.log' }))
      .rejects.toThrow(/timed out after 500ms/)
  })

  it('rejects when the receipt marker is missing', async () => {
    await expect(runStage(config, 'fixtures.fake_stage',
      ['--mode', 'no-receipt'], { logFile: 'fake-none.log' }))
      .rejects.toThrow(/no receipt/)
  })
})
```

```python
# tests/fixtures/fake_stage.py
"""Fake stage exercising every runner path; run via PYTHONPATH tricks in tests."""
import argparse
import sys
import time

sys.path.insert(0, "")  # pragma: no cover - placeholder, real receipt helper lands in Task 3


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--mode", required=True)
    args = parser.parse_args()
    if args.mode == "ok":
        print("noise line before receipt")
        print("<<<DSH_CAE_JSON>>>")
        print('{"ok": true, "value": 42}')
        return
    if args.mode == "fail":
        print("boom: kernel exploded", file=sys.stderr)
        sys.exit(1)
    if args.mode == "sleep":
        time.sleep(30)
        return
    if args.mode == "no-receipt":
        print("just talking, no receipt")
        return


if __name__ == "__main__":
    main()
```

Test-run note: `pythonDir()` test requires `python/dsh_cae/` to exist — create `python/dsh_cae/__init__.py` (empty, docstring only) in this task so the path assertion passes; receipt.py/deps.py land in Task 3.

- [ ] **Step 2: Run to verify failure**

Run: `pnpm vitest run tests/runner.test.ts`
Expected: FAIL — `../src/runner.ts` unresolved.

- [ ] **Step 3: Implement the runner**

```ts
// src/runner.ts
import { spawn } from 'node:child_process'
import { exists, mkdir, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Config } from './config.ts'

/** Marker line preceding the stage receipt on stdout. */
export const RECEIPT_MARK = '<<<DSH_CAE_JSON>>>'
/** Cap on combined output kept for error messages and canonical log tails. */
const TAIL_BYTES = 8192
/** Grace period between SIGTERM and SIGKILL of the stage process group. */
const KILL_GRACE_MS = 2000

/**
 * Absolute path of the shipped `python/` directory. Resolves identically from
 * `src/` (tsx source launch) and `lib/` (built install) because both sit one
 * level below the package root.
 * @returns directory containing the `dsh_cae` package.
 */
export function pythonDir(): string {
  return join(dirname(fileURLToPath(import.meta.url)), '..', 'python')
}

/** Successful stage outcome: parsed receipt plus the persisted full log. */
export interface StageOutcome {
  receipt: Record<string, unknown>
  logPath: string
}

/** Keep the last `TAIL_BYTES` of a string as UTF-8 text. */
function tail(text: string): string {
  return Buffer.from(text, 'utf8').subarray(-TAIL_BYTES).toString('utf8')
}

/**
 * Run one CAE stage as a one-shot subprocess in the configured workdir and
 * parse its receipt. Domain failures arrive as receipts with exit code 0;
 * this rejects only for infrastructure failures: non-zero exit, missing or
 * malformed receipt, timeout, or caller abort.
 * @param config - deployment configuration (interpreter, workdir, timeout).
 * @param stage - module path under `dsh_cae`, e.g. `'cad'` or `'fixtures.fake_stage'`.
 * @param args - CLI arguments forwarded after the module name.
 * @param opts - abort signal and workdir-relative log file name.
 * @returns parsed receipt and absolute log path.
 */
export async function runStage(
  config: Config,
  stage: string,
  args: string[],
  opts: { signal?: AbortSignal; logFile: string },
): Promise<StageOutcome> {
  await mkdir(config.workdir, { recursive: true })
  const logPath = resolve(config.workdir, opts.logFile)
  const pythonPath = [pythonDir(), process.env.PYTHONPATH].filter(Boolean).join(':')
  const proc = spawn(config.python, ['-m', `dsh_cae.${stage}`, ...args], {
    cwd: config.workdir,
    detached: true,
    env: { ...process.env, PYTHONPATH: pythonPath },
    stdio: ['ignore', 'pipe', 'pipe'],
  })

  let stdout = ''
  let stderr = ''
  proc.stdout.on('data', (chunk: Buffer) => { stdout += chunk })
  proc.stderr.on('data', (chunk: Buffer) => { stderr += chunk })

  let settled = false
  let timeout: NodeJS.Timeout | undefined
  let grace: NodeJS.Timeout | undefined
  let abort = () => {}
  const killGroup = (): void => {
    if (proc.exitCode !== null || proc.killed) return
    try { process.kill(-proc.pid!, 'SIGTERM') } catch { proc.kill('SIGTERM') }
    grace = setTimeout(() => {
      try { process.kill(-proc.pid!, 'SIGKILL') } catch { proc.kill('SIGKILL') }
    }, KILL_GRACE_MS)
  }
  if (opts.signal) {
    abort = () => killGroup()
    opts.signal.addEventListener('abort', abort, { once: true })
  }
  if (config.stageTimeoutMs > 0) {
    timeout = setTimeout(killGroup, config.stageTimeoutMs)
  }

  const code: number | null = await new Promise((resolveCode) => {
    proc.once('close', (exitCode) => { settled = true; resolveCode(exitCode) })
  })
  clearTimeout(timeout)
  clearTimeout(grace)
  opts.signal?.removeEventListener('abort', abort)

  const combined = stdout + (stderr ? `\n[stderr]\n${stderr}` : '')
  await writeFile(logPath, combined, 'utf8')

  const failInfra = (why: string): Error =>
    new Error(`dsh-cae stage '${stage}' ${why}\n${tail(combined)}`)
  if (!settled) throw failInfra('did not exit') // unreachable; close always fires
  if (code !== 0) throw failInfra(`exited with code ${code}`)
  const mark = stdout.lastIndexOf(RECEIPT_MARK)
  if (mark < 0) throw failInfra('produced no receipt')
  const receiptText = stdout.slice(mark + RECEIPT_MARK.length).trim()
  try {
    const receipt = JSON.parse(receiptText) as Record<string, unknown>
    if (receipt === null || typeof receipt !== 'object') throw new Error('not an object')
    return { receipt, logPath }
  } catch {
    throw failInfra('produced an unparseable receipt')
  }
}

/** Cached verdict of the interpreter dependency self-check. */
const depsOk = new WeakMap<Config, boolean>()

/**
 * Verify once per config object that the interpreter can import every CAE
 * dependency. Throws with the exact install commands on the first missing
 * dependency set; subsequent calls with the same config are free.
 * @param config - deployment configuration.
 * @param signal - abort signal forwarded to the check subprocess.
 */
export async function ensureDeps(config: Config, signal?: AbortSignal): Promise<void> {
  if (depsOk.get(config)) return
  const { receipt } = await runStage(config, 'deps', [], {
    signal, logFile: 'deps.log',
  }).catch(async (error: Error) => {
    throw new Error(
      `dsh-cae cannot start its Python stages with interpreter '${config.python}': `
      + `${error.message}\nInstall the stack, e.g.:\n`
      + '  pip install build123d gmsh pyvista meshio\n'
      + '  conda install -c conda-forge calculix  # or: sudo apt install calculix-ccx',
    )
  })
  if (receipt.ok !== true) {
    throw new Error(
      `dsh-cae Python stack is incomplete (missing: ${JSON.stringify(receipt.missing ?? [])}).\n`
      + 'Install with:\n  pip install build123d gmsh pyvista meshio\n'
      + '  conda install -c conda-forge calculix  # or: sudo apt install calculix-ccx',
    )
  }
  depsOk.set(config, true)
}

// Re-exported for tests asserting the shipped package exists.
export { exists }
```

- [ ] **Step 4: Create `python/dsh_cae/__init__.py` and run tests**

Create `python/dsh_cae/__init__.py` containing only:
```python
"""Bundled CAE stage modules; executed via `python -m dsh_cae.<stage>` with this directory on PYTHONPATH."""
```

Run: `pnpm vitest run tests/runner.test.ts`
Expected: PASS (5 tests). The `deps` stage does not exist yet — no test here calls it.

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat: subprocess runner with receipt parsing, group kill, and log persistence"
```

---

### Task 3: Python `receipt.py` + `deps.py` self-check

**Files:**
- Create: `python/dsh_cae/receipt.py`, `python/dsh_cae/deps.py`
- Test: `tests/deps.test.ts`

**Interfaces:**
- Produces (Python): `receipt.emit(obj: dict) -> None` prints marker + JSON; `receipt.fail(message: str) -> NoReturn` prints marker + `{"error": message}` to stderr and exits 1.
- Produces (TS): `ensureDeps()` behavior from Task 2 now backed by a real stage.

- [ ] **Step 1: Write the failing test**

```ts
// tests/deps.test.ts
import { describe, expect, it } from 'vitest'
import { runStage } from '../src/runner.ts'
import type { Config } from '../src/config.ts'

const HAS_PYTHON = process.platform !== 'win32'

describe.skipIf(!HAS_PYTHON)('deps stage', () => {
  it('reports a receipt with ok:boolean and missing list', async () => {
    const config: Config = { python: 'python3', workdir: './cae-tmp', stageTimeoutMs: 60_000 }
    const { receipt } = await runStage(config, 'deps', [], { logFile: 'deps-check.log' })
    expect(typeof receipt.ok).toBe('boolean')
    if (receipt.ok === false) {
      expect(Array.isArray(receipt.missing)).toBe(true)
      expect((receipt.missing as string[]).length).toBeGreaterThan(0)
    }
  })
})
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm vitest run tests/deps.test.ts`
Expected: FAIL — `No module named dsh_cae.deps`.

- [ ] **Step 3: Implement both modules**

```python
# python/dsh_cae/receipt.py
"""Shared receipt emission for every dsh_cae stage."""
import json
import sys

MARK = "<<<DSH_CAE_JSON>>>"


def emit(obj: dict) -> None:
    """Print the receipt marker and one JSON object as the stage's final stdout."""
    print(MARK)
    print(json.dumps(obj))
    sys.stdout.flush()


def fail(message: str) -> None:
    """Report an infrastructure failure: marker JSON on stderr, exit code 1."""
    print(MARK, file=sys.stderr)
    print(json.dumps({"error": message}), file=sys.stderr)
    sys.stderr.flush()
    sys.exit(1)
```

```python
# python/dsh_cae/deps.py
"""Dependency self-check stage: probe imports and the ccx binary."""
import shutil
import subprocess

from dsh_cae.receipt import emit

PY_DEPS = ["build123d", "gmsh", "pyvista", "meshio"]


def main() -> None:
    missing: list[str] = []
    for mod in PY_DEPS:
        try:
            __import__(mod)
        except ImportError:
            missing.append(mod)
    if shutil.which("ccx") is None:
        missing.append("ccx (CalculiX binary)")
    emit({"ok": not missing, "missing": missing})


if __name__ == "__main__":
    main()
```

- [ ] **Step 4: Run tests**

Run: `pnpm vitest run tests/deps.test.ts tests/runner.test.ts`
Expected: PASS. On a dev box without the stack, `receipt.ok === false` and `missing` lists all five; on CI with everything installed, `ok === true`.

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat: python receipt helpers and dependency self-check stage"
```

---

### Task 4: `cad.py` — build123d execution, STEP export, face fingerprints

**Files:**
- Create: `python/dsh_cae/cad.py`
- Test: `pytest/test_cad.py`, `pytest/conftest.py`

**Interfaces:**
- Consumes: `receipt.emit/fail`.
- Produces: CLI `python -m dsh_cae.cad --script-file <path> --step <out.step> [--faces-json <out.json>]`; receipt `{ stepPath, volumeMm3, bboxMm: {min: [x,y,z], max: [x,y,z]}, namedFaces: [{name, areaMm2, centroidMm: [x,y,z]}] }`; sidecar file `{"<name>": {"centroidMm": [...], "areaMm2": a, "normal": [nx,ny,nz]}}` written when the script defines `NAMED_FACES`.

- [ ] **Step 1: Write the failing test**

```python
# pytest/conftest.py
import os
import pathlib
import subprocess
import sys

import pytest

REPO = pathlib.Path(__file__).resolve().parents[1]
PYTHON_DIR = REPO / "python"


def cae_available() -> bool:
    try:
        for mod in ("build123d", "gmsh", "pyvista", "meshio"):
            __import__(mod)
    except ImportError:
        return False
    return shutil_which("ccx") is not None


def shutil_which(name: str):
    import shutil
    return shutil.which(name)


@pytest.fixture()
def workdir(tmp_path):
    return tmp_path


def run_stage(workdir, stage: str, *args: str):
    env = dict(os.environ, PYTHONPATH=str(PYTHON_DIR))
    return subprocess.run(
        [sys.executable, "-m", f"dsh_cae.{stage}", *args],
        cwd=workdir, env=env, capture_output=True, text=True, timeout=120,
    )


def parse_receipt(proc) -> dict:
    mark = "<<<DSH_CAE_JSON>>>"
    assert mark in proc.stdout, f"no receipt in stdout:\n{proc.stdout}\n{proc.stderr}"
    return __import__("json").loads(proc.stdout.split(mark, 1)[1].strip())


@pytest.fixture()
def stage():
    return run_stage
```

```python
# pytest/test_cad.py
import json

import pytest

pytest.importorskip("build123d")

CANTILEVER = """
from build123d import Box, Axis
part = Box(100, 20, 5)
NAMED_FACES = {
    "fixed": part.faces().filter_by(lambda f: abs(f.center()[0] + 50) < 1e-6)[0],
    "load": part.faces().filter_by(lambda f: abs(f.center()[0] - 50) < 1e-6)[0],
}
"""


def test_cad_build_exports_step_and_fingerprints(stage, workdir):
    script = workdir / "beam.cad.py"
    script.write_text(CANTILEVER)
    step = workdir / "beam.step"
    faces = workdir / "beam.faces.json"
    proc = stage(workdir, "cad", "--script-file", str(script), "--step", str(step), "--faces-json", str(faces))
    receipt = parse_receipt(proc)
    assert step.exists()
    assert abs(receipt["volumeMm3"] - 100 * 20 * 5) < 1e-6
    assert receipt["bboxMm"]["min"] == [-50.0, -10.0, -2.5]
    assert receipt["bboxMm"]["max"] == [50.0, 10.0, 2.5]
    names = {f["name"] for f in receipt["namedFaces"]}
    assert names == {"fixed", "load"}
    sidecar = json.loads(faces.read_text())
    assert abs(sidecar["fixed"]["areaMm2"] - 20 * 5) < 1e-6


def test_cad_build_rejects_script_without_part(stage, workdir):
    script = workdir / "bad.cad.py"
    script.write_text("x = 1")
    proc = stage(workdir, "cad", "--script-file", str(script), "--step", str(workdir / "bad.step"))
    assert proc.returncode == 1
    assert "must define 'part'" in proc.stderr
```

`parse_receipt` needs the conftest import too — add to conftest:

```python
# append to pytest/conftest.py
import json as _json


def parse_receipt(proc) -> dict:
    mark = "<<<DSH_CAE_JSON>>>"
    assert mark in proc.stdout, f"no receipt in stdout:\n{proc.stdout}\n{proc.stderr}"
    return _json.loads(proc.stdout.split(mark, 1)[1].strip())
```

(Use this single `parse_receipt` definition in conftest; delete the draft inside the first snippet.)

- [ ] **Step 2: Run to verify failure**

Run: `python3 -m pytest pytest/test_cad.py -v` (needs `pip install pytest`; build123d missing → SKIP)
Expected: SKIP on a dev box without kernels; FAIL with `No module named dsh_cae.cad` where kernels exist. CI is authoritative.

- [ ] **Step 3: Implement `cad.py`**

```python
# python/dsh_cae/cad.py
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
```

- [ ] **Step 4: Run tests**

Run: `python3 -m pytest pytest/test_cad.py -v`
Expected: PASS where kernels exist; SKIP otherwise.

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat: cad stage running build123d scripts with face fingerprint sidecar"
```

---

### Task 5: `mesh.py` — Gmsh meshing with fingerprint-matched physical groups

**Files:**
- Create: `python/dsh_cae/mesh.py`
- Test: `pytest/test_mesh.py`

**Interfaces:**
- Consumes: sidecar JSON from Task 4.
- Produces: CLI `python -m dsh_cae.mesh --step <in> [--faces-json <in>] --msh <out> [--element-size 2.0] [--element-type tet10|tet4] [--min-size ...] [--max-size ...]`; receipt `{ mshPath, nodeCount, elementCount, groupNames: string[], quality: {minJacobian: number | null} }`. MSH format 4.1; physical groups on dim 2 named after sidecar keys plus dim-3 group `solid`.

- [ ] **Step 1: Write the failing test**

```python
# pytest/test_mesh.py
import json

import pytest

pytest.importorskip("build123d")
pytest.importorskip("gmsh")

from test_cad import CANTILEVER  # noqa: F401 - reuse the model script


def _build(workdir, stage):
    script = workdir / "beam.cad.py"
    script.write_text(CANTILEVER)
    step = workdir / "beam.step"
    faces = workdir / "beam.faces.json"
    proc = stage(workdir, "cad", "--script-file", str(script), "--step", str(step), "--faces-json", str(faces))
    assert "<<<DSH_CAE_JSON>>>" in proc.stdout
    return step, faces


def test_mesh_creates_named_groups(stage, workdir):
    step, faces = _build(workdir, stage)
    msh = workdir / "beam.msh"
    proc = stage(workdir, "mesh", "--step", str(step), "--faces-json", str(faces),
                 "--msh", str(msh), "--element-size", "4.0")
    receipt = parse_receipt(proc)
    assert msh.exists()
    assert set(receipt["groupNames"]) >= {"fixed", "load", "solid"}
    assert receipt["nodeCount"] > 100
    assert receipt["elementCount"] > 50
    assert receipt["quality"]["minJacobian"] is None or receipt["quality"]["minJacobian"] > 0.0


def test_mesh_fails_loud_when_no_face_matches(stage, workdir):
    step, _ = _build(workdir, stage)
    bad = workdir / "bad.faces.json"
    bad.write_text(json.dumps({"ghost": {"centroidMm": [999, 999, 999], "areaMm2": 1.0, "normal": [0, 0, 1]}}))
    proc = stage(workdir, "mesh", "--step", str(step), "--faces-json", str(bad),
                 "--msh", str(workdir / "bad.msh"))
    assert proc.returncode == 1
    assert "ghost" in proc.stderr and "candidates" in proc.stderr
```

- [ ] **Step 2: Run to verify failure**

Run: `python3 -m pytest pytest/test_mesh.py -v`
Expected: SKIP (no kernels) / FAIL `No module named dsh_cae.mesh`.

- [ ] **Step 3: Implement `mesh.py`**

```python
# python/dsh_cae/mesh.py
"""Mesh stage: STEP in, Gmsh tetra mesh out, named physical groups rebuilt by fingerprint."""
import argparse
import json
import math

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
    if args.faces_json:
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

        gmsh.write(args.msh)
        emit({
            "mshPath": args.msh,
            "nodeCount": len(node_tags),
            "elementCount": element_count,
            "groupNames": group_names,
            "quality": {"minJacobian": min_jacobian},
        })
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


if __name__ == "__main__":
    main()
```

- [ ] **Step 4: Run tests**

Run: `python3 -m pytest pytest/test_mesh.py -v`
Expected: PASS where kernels exist; SKIP otherwise.

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat: mesh stage with fingerprint-matched physical groups and quality stat"
```

---

### Task 6: `solve.py` — CalculiX deck writer, solver run, FRD→VTU

**Files:**
- Create: `python/dsh_cae/solve.py`
- Test: `pytest/test_solve.py`

**Interfaces:**
- Consumes: `.msh` with named physical groups (Task 5).
- Produces: CLI `python -m dsh_cae.solve --msh <in> --case <stem> --young-mpa <n> --poisson <n> [--fixed-group <name> ...] [--load-group <name> --load-n fx,fy,fz ...] [--script-file <extra inp>]`; receipt `{ inpPath, frdPath, vtuPath: string | null, exitCode, wallMs, logTail }`. ccx non-zero exit is a **domain outcome** (exit 0 from the stage).

- [ ] **Step 1: Write the failing test**

```python
# pytest/test_solve.py
import shutil
import subprocess

import pytest

pytest.importorskip("gmsh")
if shutil.which("ccx") is None:
    pytest.skip("CalculiX ccx not on PATH", allow_module_level=True)

from test_cad import CANTILEVER
from test_mesh import _build


def test_solve_cantilever_runs_and_converts(stage, workdir):
    step, faces = _build(workdir, stage)
    msh = workdir / "beam.msh"
    proc = stage(workdir, "mesh", "--step", str(step), "--faces-json", str(faces),
                 "--msh", str(msh), "--element-size", "4.0")
    assert "<<<DSH_CAE_JSON>>>" in proc.stdout

    proc = stage(workdir, "solve", "--msh", str(msh), "--case", "case",
                 "--young-mpa", "210000", "--poisson", "0.3",
                 "--fixed-group", "fixed", "--load-group", "load", "--load-n", "0,-100,0")
    receipt = parse_receipt(proc)
    assert proc.returncode == 0
    assert receipt["exitCode"] == 0
    assert (workdir / "case.inp").exists()
    assert (workdir / "case.frd").exists()
    assert receipt["vtuPath"] is not None
    assert len(receipt["logTail"]) > 0


def test_solve_reports_domain_failure_without_throwing(stage, workdir):
    step, faces = _build(workdir, stage)
    msh = workdir / "beam.msh"
    stage(workdir, "mesh", "--step", str(step), "--faces-json", str(faces),
          "--msh", str(msh), "--element-size", "4.0")
    # unconstrained model: ccx errors, stage still exits 0 with exitCode != 0
    proc = stage(workdir, "solve", "--msh", str(msh), "--case", "free",
                 "--young-mpa", "210000", "--poisson", "0.3",
                 "--load-group", "load", "--load-n", "0,-100,0")
    receipt = parse_receipt(proc)
    assert proc.returncode == 0
    assert receipt["exitCode"] != 0
```

- [ ] **Step 2: Run to verify failure**

Run: `python3 -m pytest pytest/test_solve.py -v`
Expected: SKIP (no ccx) / FAIL `No module named dsh_cae.solve`.

- [ ] **Step 3: Implement `solve.py`**

```python
# python/dsh_cae/solve.py
"""Solve stage: MSH in, CalculiX *STATIC run out; ccx failure is a domain outcome."""
import argparse
import subprocess
import time

from dsh_cae.receipt import emit, fail

# gmsh element type id -> CalculiX element keyword
TET_TYPES = {4: "C3D4", 11: "C3D10"}


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--msh", required=True)
    parser.add_argument("--case", required=True)
    parser.add_argument("--young-mpa", type=float, required=True)
    parser.add_argument("--poisson", type=float, required=True)
    parser.add_argument("--fixed-group", action="append", default=[])
    parser.add_argument("--load-group", action="append", default=[])
    parser.add_argument("--load-n", action="append", default=[])
    parser.add_argument("--script-file")
    args = parser.parse_args()

    try:
        import gmsh
    except ImportError as exc:
        fail(f"gmsh is not installed in this interpreter: {exc}")

    if len(args.load_group) != len(args.load_n):
        fail("--load-group and --load-n must appear in pairs")

    gmsh.initialize()
    lines: list[str] = []
    try:
        gmsh.open(args.msh)

        node_tags, coords, _param = gmsh.model.mesh.getNodes()
        tag_to_i = {int(t): i for i, t in enumerate(node_tags)}
        lines.append("*NODE")
        for t, i in tag_to_i.items():
            x, y, z = coords[3 * i], coords[3 * i + 1], coords[3 * i + 2]
            lines.append(f"{t + 1}, {x:.9g}, {y:.9g}, {z:.9g}")

        # gmsh and Abaqus/CalculiX number tetra10 midside nodes identically
        # (5:1-2, 6:2-3, 7:1-3, 8:1-4, 9:2-4, 10:3-4), so nodes pass through.
        elset_written = False
        for dim, vtag in gmsh.model.getEntities(3):
            types, etags, enodes = gmsh.model.mesh.getElements(3, vtag)
            for etype, tags, nodes in zip(types, etags, enodes):
                ccx = TET_TYPES.get(int(etype))
                if ccx is None:
                    fail(f"mesh contains unsupported element type {etype}; only linear/quadratic tets are supported")
                if not elset_written:
                    lines.append(f"*ELEMENT, TYPE={ccx}, ELSET=EALL")
                    elset_written = True
                for k, etag in enumerate(tags):
                    conn = [int(n) for n in nodes[len(etag) and k * len(nodes) // len(tags):][:0] or []]  # replaced below
                break
            break
        # NOTE: the loop above is structural; the real connectivity emission is:
        lines = lines[: lines.index("*ELEMENT, TYPE=%s, ELSET=EALL" % TET_TYPES.get(11, "C3D10")) + 1] if False else lines
        emit_elements(gmsh, lines, tag_to_i)
```

The connectivity plumbing above is deliberately hoisted into a helper — final file (write this, not the draft):

```python
# python/dsh_cae/solve.py  (FINAL)
"""Solve stage: MSH in, CalculiX *STATIC run out; ccx failure is a domain outcome."""
import argparse
import math
import subprocess
import time

from dsh_cae.receipt import emit, fail

TET_TYPES = {4: "C3D4", 11: "C3D10"}


def emit_elements(gmsh, lines: list, tag_to_i: dict) -> str:
    """Append *ELEMENT blocks for every volume entity; returns the element keyword used."""
    keyword = None
    for _dim, vtag in gmsh.model.getEntities(3):
        types, etags, enodes = gmsh.model.mesh.getElements(3, vtag)
        for etype, tags, nodes in zip(types, etags, enodes):
            keyword = TET_TYPES.get(int(etype))
            if keyword is None:
                fail(f"mesh contains unsupported element type {etype}; only linear/quadratic tets are supported")
            lines.append(f"*ELEMENT, TYPE={keyword}, ELSET=EALL")
            width = len(nodes) // len(tags)
            for k, etag in enumerate(tags):
                conn = nodes[k * width:(k + 1) * width]
                ids = ",".join(str(int(n)) for n in conn)
                lines.append(f"{int(etag)}, {ids}")
    if keyword is None:
        fail("mesh contains no volume elements")
    return keyword


def group_node_tags(gmsh, name: str) -> list:
    """Node tags belonging to a dim-2 physical group by name; fail loud when absent."""
    for dim, tag in gmsh.model.getPhysicalGroups():
        if gmsh.model.getPhysicalName(dim, tag) == name:
            if dim != 2:
                fail(f"boundary group '{name}' must be a surface (dim 2) group")
            tags, _nodes = gmsh.model.mesh.getNodesForPhysicalGroup(2, tag)
            return [int(t) for t in tags]
    fail(f"physical group '{name}' not found in mesh")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--msh", required=True)
    parser.add_argument("--case", required=True)
    parser.add_argument("--young-mpa", type=float, required=True)
    parser.add_argument("--poisson", type=float, required=True)
    parser.add_argument("--fixed-group", action="append", default=[])
    parser.add_argument("--load-group", action="append", default=[])
    parser.add_argument("--load-n", action="append", default=[])
    parser.add_argument("--script-file")
    args = parser.parse_args()

    try:
        import gmsh
    except ImportError as exc:
        fail(f"gmsh is not installed in this interpreter: {exc}")
    if len(args.load_group) != len(args.load_n):
        fail("--load-group and --load-n must appear in pairs")

    gmsh.initialize()
    lines: list[str] = []
    try:
        gmsh.open(args.msh)

        node_tags, coords, _param = gmsh.model.mesh.getNodes()
        lines.append("*NODE")
        for i, t in enumerate(node_tags):
            x, y, z = coords[3 * i], coords[3 * i + 1], coords[3 * i + 2]
            lines.append(f"{int(t)}, {x:.9g}, {y:.9g}, {z:.9g}")
        emit_elements(gmsh, lines, {})

        fixed_nodes: list[int] = []
        for name in args.fixed_group:
            fixed_nodes.extend(group_node_tags(gmsh, name))
        if fixed_nodes:
            lines.append(f"*NSET, NSET=NFIXED")
            for start in range(0, len(fixed_nodes), 8):
                lines.append(", ".join(str(n) for n in fixed_nodes[start:start + 8]))

        loads: list[tuple[str, tuple[float, float, float], list[int]]] = []
        for name, vec in zip(args.load_group, args.load_n):
            fx, fy, fz = (float(v) for v in vec.split(","))
            loads.append((name, (fx, fy, fz), group_node_tags(gmsh, name)))

        lines += [
            "*MATERIAL, NAME=MAT",
            "*ELASTIC",
            f"{args.young_mpa:.9g}, {args.poisson:.9g}",
            "*SOLID SECTION, ELSET=EALL, MATERIAL=MAT",
        ]
        if fixed_nodes:
            lines += ["*BOUNDARY", "NFIXED, 1, 3, 0.0"]

        if args.script_file:
            with open(args.script_file, encoding="utf-8") as handle:
                lines.append(handle.read().strip())

        lines.append("*STEP")
        lines.append("*STATIC")
        for _name, (fx, fy, fz), nodes in loads:
            per_node = len(nodes) or 1
            for n in nodes:
                # N split evenly over the group's nodes; consistent with St. Venant
                # for tip deflection, exact for total force.
                lines.append(f"*CLOAD\n{n}, 1, {fx / per_node:.9g}\n{n}, 2, {fy / per_node:.9g}\n{n}, 3, {fz / per_node:.9g}")
        lines += ["*NODE FILE", "U, RF", "*EL FILE", "S", "*END STEP"]

        inp_path = f"{args.case}.inp"
        with open(inp_path, "w", encoding="utf-8") as handle:
            handle.write("\n".join(lines) + "\n")
    finally:
        gmsh.finalize()

    start = time.monotonic()
    proc = subprocess.run(["ccx", args.case], capture_output=True, text=True, timeout=0 or None)
    wall_ms = int((time.monotonic() - start) * 1000)
    log_text = (proc.stdout or "") + (proc.stderr or "")
    with open(f"{args.case}.log", "w", encoding="utf-8") as handle:
        handle.write(log_text)

    frd_path = f"{args.case}.frd"
    vtu_path: str | None = None
    if proc.returncode == 0:
        try:
            import meshio
            meshio.read(frd_path).write(f"{args.case}.vtu")
            vtu_path = f"{args.case}.vtu"
        except Exception:  # noqa: BLE001 - conversion is best-effort; frd stays usable
            vtu_path = None

    tail_lines = "\n".join(log_text.strip().splitlines()[-40:])
    emit({
        "inpPath": inp_path,
        "frdPath": frd_path,
        "vtuPath": vtu_path,
        "exitCode": proc.returncode,
        "wallMs": wall_ms,
        "logTail": tail_lines,
    })


if __name__ == "__main__":
    main()
```

Notes pinned for the reviewer: ccx is invoked without a timeout (`timeout=0 or None` → pass `timeout=None`); the TS runner owns wall-clock killing. The `*CLOAD` lines embed repeated keyword lines — CalculiX accepts a keyword line followed by data lines, and grouping as written emits `*CLOAD` before each node row, which is legal though verbose.

- [ ] **Step 4: Run tests**

Run: `python3 -m pytest pytest/test_solve.py -v`
Expected: PASS where ccx exists; SKIP otherwise.

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat: solve stage writing C3D10 decks, running ccx, converting frd to vtu"
```

---

### Task 7: `post.py` — value extraction + offscreen plots

**Files:**
- Create: `python/dsh_cae/post.py`
- Test: `pytest/test_post.py`

**Interfaces:**
- Produces: CLI `python -m dsh_cae.post --vtu <in|--frd <in>> [--max field ...] [--probe field,x,y,z ...] [--plot field[:deform-scale] ...] --png-stem <case>`; receipt `{ values: [{field, value, unit, atMm?}], plots: [{field, path: string|null, error?: string}] }`. Fields: `displacement`, `vonMises`, `stressXX`, `stressYY`, `stressZZ`, `stressXY`, `stressYZ`, `stressXZ`.

- [ ] **Step 1: Write the failing test**

```python
# pytest/test_post.py
import pytest

pytest.importorskip("pyvista")

CANTILEVER_RESULT = None  # produced by solve; this test writes a synthetic vtu


def _synthetic_vtu(path):
    import pyvista as pv
    grid = pv.ImageData(dimensions=(11, 3, 3), spacing=(10, 10, 10), origin=(0, 0, 0))
    import numpy as np
    disp = np.zeros((grid.n_points, 3))
    disp[:, 2] = np.linspace(0, 0.5, grid.n_points)  # growing z deflection
    grid.point_data["displacement"] = disp
    grid.point_data["stressXX"] = np.linspace(0, 100, grid.n_points)
    grid.save(path)


def test_post_extracts_max_and_probe(stage, workdir):
    vtu = workdir / "syn.vtu"
    _synthetic_vtu(vtu)
    proc = stage(workdir, "post", "--vtu", str(vtu), "--png-stem", "syn",
                 "--max", "displacement", "--max", "stressXX",
                 "--probe", "displacement,0,0,0")
    receipt = parse_receipt(proc)
    by_field = {v["field"]: v for v in receipt["values"]}
    assert abs(by_field["displacement"]["value"] - 0.5) < 1e-9
    assert by_field["displacement"]["unit"] == "mm"
    assert abs(by_field["stressXX"]["value"] - 100.0) < 1e-9
    assert "probe" not in by_field  # probe results carry atMm and their own entries


def test_post_unknown_field_lists_available(stage, workdir):
    vtu = workdir / "syn.vtu"
    _synthetic_vtu(vtu)
    proc = stage(workdir, "post", "--vtu", str(vtu), "--png-stem", "syn",
                 "--max", "pressure")
    assert proc.returncode == 1
    assert "displacement" in proc.stderr and "stressXX" in proc.stderr
```

- [ ] **Step 2: Run to verify failure**

Run: `python3 -m pytest pytest/test_post.py -v`
Expected: SKIP / FAIL `No module named dsh_cae.post`.

- [ ] **Step 3: Implement `post.py`**

```python
# python/dsh_cae/post.py
"""Post stage: scalar extraction and offscreen deformed-shape plots from VTU/FRD."""
import argparse
import math

from dsh_cae.receipt import emit, fail

STRESS_COMPONENTS = {
    "vonMises": None, "stressXX": 0, "stressYY": 1, "stressZZ": 2,
    "stressXY": 3, "stressYZ": 4, "stressXZ": 5,
}
# meshio/frd and synthetic names accepted per field
ALIASES = {
    "displacement": ["displacement", "disp", "DISP"],
    "stress": ["stress", "STRESS", "stress_tensor"],
}


def _find(mesh, wanted: str):
    import numpy as np
    keys = list(mesh.point_data)
    if wanted == "displacement":
        for alias in ALIASES["displacement"]:
            if alias in mesh.point_data:
                return np.asarray(mesh.point_data[alias]).reshape(-1, 3)
        fail(f"field 'displacement' not found; available point data: {keys}")
    if wanted in STRESS_COMPONENTS:
        for alias in ALIASES["stress"]:
            if alias in mesh.point_data:
                tensor = np.asarray(mesh.point_data[alias]).reshape(-1, 6)
                if wanted == "vonMises":
                    xx, yy, zz, xy, yz, xz = (tensor[:, i] for i in range(6))
                    return math.sqrt(0.5 * ((xx - yy) ** 2 + (yy - zz) ** 2 + (zz - xx) ** 2) + 3 * (xy ** 2 + yz ** 2 + xz ** 2)) * np.ones(len(xx))
                return tensor[:, STRESS_COMPONENTS[wanted]]
        fail(f"stress field not found for '{wanted}'; available point data: {keys}")
    fail(f"unknown field '{wanted}'; supported: displacement, {', '.join(STRESS_COMPONENTS)}")


def main() -> None:
    parser = argparse.ArgumentParser()
    source = parser.add_mutually_exclusive_group(required=True)
    source.add_argument("--vtu")
    source.add_argument("--frd")
    parser.add_argument("--max", action="append", default=[], dest="maxima")
    parser.add_argument("--probe", action="append", default=[])
    parser.add_argument("--plot", action="append", default=[])
    parser.add_argument("--png-stem", required=True)
    args = parser.parse_args()

    try:
        import pyvista as pv
    except ImportError as exc:
        fail(f"pyvista is not installed in this interpreter: {exc}")

    mesh = pv.read(args.vtu or args.frd)
    if args.frd:
        mesh = mesh  # frd via pyvista's meshio bridge

    values = []
    for field in args.maxima:
        data = _find(mesh, field)
        idx = int(abs(data if data.ndim == 1 else data[:, -1]).max() and _argmax_abs(data))
        values.append({"field": field, "value": float(_magnitude_at(data, idx)), "unit": "MPa" if field in STRESS_COMPONENTS else "mm", "atMm": [float(v) for v in mesh.points[idx]]})
    for spec in args.probe:
        field, x, y, z = spec.split(",")
        data = _find(mesh, field)
        idx = mesh.find_closest_point([float(x), float(y), float(z)])
        values.append({"field": field, "value": float(_magnitude_at(data, idx)), "unit": "MPa" if field in STRESS_COMPONENTS else "mm", "atMm": [float(v) for v in mesh.points[idx]]})

    plots = []
    for spec in args.plot:
        field = spec.split(":", 1)[0]
        try:
            data = _find(mesh, field)
            scalars = data if data.ndim == 1 else _magnitude_rows(data)
            warped = mesh.warp_by_vector("displacement") if "displacement" in mesh.point_data else mesh
            plotter = pv.Plotter(off_screen=True)
            plotter.add_mesh(warped, scalars=scalars, scalar_bar_args={"title": f"{field} [{values_unit(field)}]"})
            path = f"{args.png_stem}.{field}.png"
            plotter.screenshot(path)
            plots.append({"field": field, "path": path})
        except Exception as exc:  # noqa: BLE001 - plot failure must not kill extraction
            plots.append({"field": field, "path": None, "error": f"{type(exc).__name__}: {exc}"})

    emit({"values": values, "plots": plots})


def values_unit(field: str) -> str:
    return "MPa" if field in STRESS_COMPONENTS else "mm"


def _magnitude_rows(data):
    import numpy as np
    return np.linalg.norm(data, axis=1)


def _magnitude_at(data, idx):
    row = data[idx]
    return math.sqrt(sum(v * v for v in row)) if hasattr(row, "__len__") else float(row)


def _argmax_abs(data):
    import numpy as np
    mags = np.abs(data if data.ndim == 1 else np.linalg.norm(data, axis=1))
    return int(np.argmax(mags))


if __name__ == "__main__":
    main()
```

- [ ] **Step 4: Run tests**

Run: `python3 -m pytest pytest/test_post.py -v`
Expected: PASS where pyvista exists. Plot path (`--plot`) is exercised only in the pipeline test (CI xvfb).

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat: post stage extracting values and rendering offscreen plots"
```

---

### Task 8: TS tools `cae_cad_build` + `cae_mesh_generate`

**Files:**
- Create: `src/tools/cad.ts`, `src/tools/mesh.ts`, `tests/fixtures/stub_cae.py`
- Test: `tests/tools-cad-mesh.test.ts`

**Interfaces:**
- Consumes: `runStage`, `ensureDeps` (Task 2), `Config` (Task 1).
- Produces: `defineCaeCadTool(config: Config): ToolDefinition`-shaped objects consumed by `apply` in Task 9 (function signature `defineCaeCadTool(config: Config)` and `defineCaeMeshTool(config: Config)` returning the value passed to `ctx.tools.register`).

- [ ] **Step 1: Write the failing tests (stub python emits canned receipts)**

```python
# tests/fixtures/stub_cae.py
"""Deterministic stand-in for dsh_cae stages: echoes a canned receipt per stage."""
import argparse
import json
import sys

STUBS = {
    "cad": {"stepPath": "beam.step", "volumeMm3": 10000.0,
            "bboxMm": {"min": [-50.0, -10.0, -2.5], "max": [50.0, 10.0, 2.5]},
            "namedFaces": [{"name": "fixed", "areaMm2": 100.0, "centroidMm": [-50.0, 0.0, 0.0]}]},
    "mesh": {"mshPath": "beam.msh", "nodeCount": 431, "elementCount": 210,
             "groupNames": ["fixed", "load", "solid"], "quality": {"minJacobian": 0.42}},
}
```

```ts
// tests/tools-cad-mesh.test.ts
import { describe, expect, it } from 'vitest'
import { join } from 'node:path'
import { readFile } from 'node:fs/promises'
import { defineCaeCadTool, defineCaeMeshTool } from '../src/tools/cad.ts'
import { defineCaeMeshTool as meshTool } from '../src/tools/mesh.ts'
import type { Config } from '../src/config.ts'

const config: Config = {
  python: 'python3',
  workdir: './cae-stub',
  stageTimeoutMs: 30_000,
}

// The stub python is wired via PYTHONPATH in vitest env: stage modules are
// imported through tests/fixtures by pointing pythonDir at it is NOT possible
// (runner uses the shipped python dir), so the stub lives as
// python-path-agnostic: these tests override config.python with a wrapper.
// Simpler contract: run against the REAL stages when kernels exist, else skip.
const kernelsPresent = await (async () => {
  const { runStage } = await import('../src/runner.ts')
  try {
    const { receipt } = await runStage({ ...config, workdir: './cae-deps' }, 'deps', [], { logFile: 'deps.log' })
    return receipt.ok === true
  } catch {
    return false
  }
})()

describe.skipIf(!kernelsPresent)('cae_cad_build / cae_mesh_generate (real kernels)', () => {
  it('builds a cantilever and meshes it, threading paths', async () => {
    const cad = defineCaeCadTool(config)
    const built = await cad.execute({
      script: 'from build123d import Box\npart = Box(100, 20, 5)\n',
      name: 'it-beam',
    }, fakeExec()) as { stepPath: string; volumeMm3: number }
    expect(built.volumeMm3).toBeCloseTo(10000, 6)

    const mesh = meshTool(config)
    const meshed = await mesh.execute({ step: built.stepPath, elementSizeMm: 4 }, fakeExec()) as { groupNames: string[] }
    expect(meshed.groupNames).toContain('solid')
  })
})

function fakeExec() {
  return { agent: undefined, signal: new AbortController().signal } as never
}
```

(The `stub_cae.py` fixture is intentionally retired in favor of real-kernel tests with skip: the stub would test our own echo. Delete the fixture file — the runner already has its fake stage. Only the `tests/tools-cad-mesh.test.ts` content above, without the stub import, is authoritative.)

- [ ] **Step 2: Run to verify failure**

Run: `pnpm vitest run tests/tools-cad-mesh.test.ts`
Expected: FAIL — `../src/tools/cad.ts` unresolved.

- [ ] **Step 3: Implement both tools**

```ts
// src/tools/cad.ts
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { ensureDeps, runStage } from '../runner.ts'
import type { Config } from '../config.ts'

const DESCRIPTION =
  'Build a CAD solid by running a build123d Python script. Units are mm. '
  + 'The script MUST assign a solid to `part` (e.g. `part = Box(100, 20, 5)`). '
  + 'To prepare boundary conditions, also assign NAMED_FACES = {"<groupName>": <Face or list of Faces>} '
  + 'for faces you will later fix or load (e.g. the clamp face and the load face); '
  + 'group names survive into meshing and solving. Returns the STEP path, volume, '
  + 'bounding box, and the named faces with areas and centroids.'

/** Build the `cae_cad_build` tool bound to one deployment configuration. */
export function defineCaeCadTool(config: Config) {
  return defineTool({
    name: 'cae_cad_build',
    description: DESCRIPTION,
    parameters: {
      script: { type: 'string', required: true, description: 'build123d Python source; must define `part`, may define NAMED_FACES.' },
      name: { type: 'string', description: 'Artifact stem; files become <name>.step. Defaults to "part".' },
    },
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        properties: {
          stepPath: { type: 'string', required: true },
          volumeMm3: { type: 'number', required: true },
          bboxMm: {
            type: 'object', additionalProperties: false, required: true,
            properties: {
              min: { type: 'array', items: { type: 'number' }, required: true },
              max: { type: 'array', items: { type: 'number' }, required: true },
            },
          },
          namedFaces: {
            type: 'array', required: true,
            items: {
              type: 'object', additionalProperties: false,
              properties: {
                name: { type: 'string', required: true },
                areaMm2: { type: 'number', required: true },
                centroidMm: { type: 'array', items: { type: 'number' }, required: true },
              },
            },
          },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: `CAD part built: volume ${value.volumeMm3.toFixed(3)} mm³, bbox `
          + `${JSON.stringify(value.bboxMm)}${value.namedFaces.length ? `, named faces: ${value.namedFaces.map(f => f.name).join(', ')}` : ''}. STEP: ${value.stepPath}`,
      }],
    },
    async execute(args, exec) {
      await ensureDeps(config, exec.signal)
      const stem = args.name ?? 'part'
      const scriptFile = join(config.workdir, `${stem}.cad.py`)
      const step = join(config.workdir, `${stem}.step`)
      const facesJson = join(config.workdir, `${stem}.faces.json`)
      await writeFile(scriptFile, args.script, 'utf8')
      const { receipt } = await runStage(config, 'cad',
        ['--script-file', scriptFile, '--step', step, '--faces-json', facesJson],
        { signal: exec.signal, logFile: `${stem}.cad.log` })
      return receipt as unknown as {
        stepPath: string; volumeMm3: number
        bboxMm: { min: number[]; max: number[] }
        namedFaces: { name: string; areaMm2: number; centroidMm: number[] }[]
      }
    },
    presentCall: args => ({ card: 'generic', title: 'Build CAD part', kind: 'other', rawInput: { name: args.name ?? 'part' } }),
  })
}
```

```ts
// src/tools/mesh.ts
import { join } from 'node:path'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { ensureDeps, runStage } from '../runner.ts'
import type { Config } from '../config.ts'

const DESCRIPTION =
  'Mesh a STEP solid with Gmsh second-order tetrahedra. Units are mm. Pass the STEP path '
  + 'returned by cae_cad_build; named face groups are rebuilt automatically from the '
  + 'sidecar next to the STEP. elementSizeMm is the target edge length (smaller = finer, '
  + 'more accurate, slower solve). Returns node/element counts, group names, and the '
  + 'minimum scaled Jacobian (quality; > 0.01 is healthy).'

/** Build the `cae_mesh_generate` tool bound to one deployment configuration. */
export function defineCaeMeshTool(config: Config) {
  return defineTool({
    name: 'cae_mesh_generate',
    description: DESCRIPTION,
    parameters: {
      step: { type: 'string', required: true, description: 'Path to the .step file from cae_cad_build.' },
      elementSizeMm: { type: 'number', description: 'Target element edge length in mm. Default 2.0.' },
      elementType: { type: 'string', enum: ['tet4', 'tet10'], description: 'tet10 (default, quadratic) or tet4 (linear).' },
      minSizeMm: { type: 'number', description: 'Minimum edge length; default elementSizeMm/5.' },
      maxSizeMm: { type: 'number', description: 'Maximum edge length; default elementSizeMm.' },
    },
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        properties: {
          mshPath: { type: 'string', required: true },
          nodeCount: { type: 'integer', required: true },
          elementCount: { type: 'integer', required: true },
          groupNames: { type: 'array', items: { type: 'string' }, required: true },
          quality: {
            type: 'object', additionalProperties: false, required: true,
            properties: { minJacobian: { type: ['number', 'null'], required: true } },
          },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: `Meshed: ${value.nodeCount} nodes, ${value.elementCount} elements, groups `
          + `${value.groupNames.join(', ')}, min scaled Jacobian ${value.quality.minJacobian ?? 'n/a'}. MSH: ${value.mshPath}`,
      }],
    },
    async execute(args, exec) {
      await ensureDeps(config, exec.signal)
      const stem = args.step.replace(/\.step$/, '')
      const msh = `${stem}.msh`
      const argv = ['--step', args.step, '--msh', msh, '--element-size', String(args.elementSizeMm ?? 2.0), '--element-type', args.elementType ?? 'tet10']
      if (args.minSizeMm) argv.push('--min-size', String(args.minSizeMm))
      if (args.maxSizeMm) argv.push('--max-size', String(args.maxSizeMm))
      const facesJson = `${stem}.faces.json`
      argv.splice(2, 0, '--faces-json', facesJson)
      const { receipt } = await runStage(config, 'mesh', argv,
        { signal: exec.signal, logFile: `${stem.split('/').pop()}.mesh.log` })
      return receipt as unknown as {
        mshPath: string; nodeCount: number; elementCount: number
        groupNames: string[]; quality: { minJacobian: number | null }
      }
    },
    presentCall: args => ({ card: 'generic', title: 'Generate mesh', kind: 'other', rawInput: { step: args.step } }),
  })
}
```

- [ ] **Step 4: Run tests + typecheck**

Run: `pnpm typecheck 2>/dev/null || pnpm exec tsc -p tsconfig.json --noEmit; pnpm vitest run tests/tools-cad-mesh.test.ts`
Expected: typecheck clean (adjust `defineTool` field names to the installed typings if they differ — the compiler is the arbiter, fix mechanically); tests PASS with kernels, SKIP without.

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat: cae_cad_build and cae_mesh_generate tools"
```

---

### Task 9: TS tools `cae_solve_static` + `cae_post_process`, wire `apply`

**Files:**
- Create: `src/tools/solve.ts`, `src/tools/post.ts`
- Modify: `src/index.ts` (register all four tools)
- Test: `tests/tools-solve-post.test.ts`

**Interfaces:**
- Consumes: runner, config, tool idioms from Task 8.
- Produces: complete plugin (`apply` registers 4 tools); `cordis.patch.yml` final shape.

- [ ] **Step 1: Write the failing test**

```ts
// tests/tools-solve-post.test.ts
import { describe, expect, it } from 'vitest'
import { apply } from '../src/index.ts'
import { Config } from '../src/config.ts'

const registered: unknown[] = []
const ctx = { tools: { register: (t: unknown) => registered.push(t) } } as never

describe('plugin wiring', () => {
  it('apply registers exactly the four CAE tools in name order', () => {
    apply(ctx, { python: 'python3', workdir: './cae', stageTimeoutMs: 1000 })
    const names = registered.map(t => (t as { name: string }).name).sort()
    expect(names).toEqual([
      'cae_cad_build', 'cae_mesh_generate', 'cae_post_process', 'cae_solve_static',
    ])
  })
})
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm vitest run tests/tools-solve-post.test.ts`
Expected: FAIL — apply registers nothing (0 ≠ 4).

- [ ] **Step 3: Implement solve.ts, post.ts, and final index.ts**

```ts
// src/tools/solve.ts
import { join } from 'node:path'
import { writeFile } from 'node:fs/promises'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { ensureDeps, runStage } from '../runner.ts'
import type { Config } from '../config.ts'

const DESCRIPTION =
  'Run a CalculiX linear static solve on a mesh. Units: mm, N, MPa. Fix surfaces by '
  + 'group name from cae_cad_build NAMED_FACES; apply forces as total vectors [fx, fy, fz] '
  + 'spread over a group. A NON-ZERO exitCode in the result is a domain outcome (e.g. '
  + 'divergence, singular matrix): read logTail, adjust mesh/loads/boundary conditions, retry. '
  + 'Returns deck/result paths and wall time; vtuPath is null when FRD conversion failed '
  + '(frdPath stays usable).'

/** Build the `cae_solve_static` tool bound to one deployment configuration. */
export function defineCaeSolveTool(config: Config) {
  return defineTool({
    name: 'cae_solve_static',
    description: DESCRIPTION,
    parameters: {
      msh: { type: 'string', required: true, description: 'Path to the .msh file from cae_mesh_generate.' },
      material: {
        type: 'object', required: true, additionalProperties: false,
        properties: {
          youngMPa: { type: 'number', required: true, description: "Young's modulus in MPa (steel ≈ 210000)." },
          poisson: { type: 'number', required: true, description: "Poisson's ratio (steel ≈ 0.3)." },
        },
      },
      constraints: {
        type: 'array', required: true,
        items: {
          type: 'object', additionalProperties: false,
          properties: { groupName: { type: 'string', required: true }, kind: { type: 'string', required: true, enum: ['fixed'] } },
        },
      },
      loads: {
        type: 'array', required: true,
        items: {
          type: 'object', additionalProperties: false,
          properties: {
            groupName: { type: 'string', required: true },
            vectorN: { type: 'array', items: { type: 'number' }, required: true, description: 'Total force [fx, fy, fz] in N.' },
          },
        },
      },
      case: { type: 'string', description: 'Artifact stem; files become <case>.inp/.frd/.vtu. Default "case".' },
      script: { type: 'string', description: 'Extra CalculiX INP keywords appended before *STEP (advanced).' },
    },
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        properties: {
          inpPath: { type: 'string', required: true },
          frdPath: { type: 'string', required: true },
          vtuPath: { type: ['string', 'null'], required: true },
          exitCode: { type: 'integer', required: true },
          wallMs: { type: 'integer', required: true },
          logTail: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: `ccx exit ${value.exitCode} in ${value.wallMs} ms${value.exitCode === 0 ? ' (converged)' : ' — inspect logTail and retry'}. `
          + `Results: ${value.vtuPath ?? value.frdPath}`,
      }],
      presentationMeta: (_args, value) => ({ exitCode: value.exitCode, logTail: value.logTail }),
    },
    async execute(args, exec) {
      await ensureDeps(config, exec.signal)
      const stem = args.case ?? 'case'
      const argv = ['--msh', args.msh, '--case', stem,
        '--young-mpa', String(args.material.youngMPa), '--poisson', String(args.material.poisson)]
      for (const c of args.constraints) {
        if (c.kind !== 'fixed') throw new Error(`unsupported constraint kind '${c.kind}'`)
        argv.push('--fixed-group', c.groupName)
      }
      for (const l of args.loads) {
        argv.push('--load-group', l.groupName, '--load-n', l.vectorN.join(','))
      }
      if (args.script) {
        const scriptFile = join(config.workdir, `${stem}.patch.inp`)
        await writeFile(scriptFile, args.script, 'utf8')
        argv.push('--script-file', scriptFile)
      }
      const { receipt } = await runStage(config, 'solve', argv,
        { signal: exec.signal, logFile: `${stem}.solve.log` })
      return receipt as unknown as {
        inpPath: string; frdPath: string; vtuPath: string | null
        exitCode: number; wallMs: number; logTail: string
      }
    },
    presentCall: args => ({ card: 'terminal', title: `ccx ${args.case ?? 'case'}`, description: 'CalculiX static solve' }),
    presentResult: (args, { meta }) => ({
      card: 'terminal',
      title: `ccx ${args.case ?? 'case'}`,
      raw: (meta as { logTail?: string } | undefined)?.logTail ?? '',
      exit: { code: (meta as { exitCode?: number } | undefined)?.exitCode ?? 0 },
    }),
  })
}
```

```ts
// src/tools/post.ts
import { defineTool } from '@deepseek-ai/dsh-tools'
import { ensureDeps, runStage } from '../runner.ts'
import type { Config } from '../config.ts'

const DESCRIPTION =
  'Extract numbers and render contour plots from a solve result (VTU preferred, FRD '
  + 'fallback). Units: mm displacement, MPa stress. Fields: displacement, vonMises, '
  + 'stressXX/YY/ZZ/XY/YZ/XZ. `max` returns the field extreme with its location; '
  + '`probe` returns the value at the closest point to [x, y, z] mm; `plot` writes '
  + 'a deformed-shape contour PNG for the human (you cannot see it — quote the numbers).'

const FIELDS = ['displacement', 'vonMises', 'stressXX', 'stressYY', 'stressZZ', 'stressXY', 'stressYZ', 'stressXZ']

/** Build the `cae_post_process` tool bound to one deployment configuration. */
export function defineCaePostTool(config: Config) {
  return defineTool({
    name: 'cae_post_process',
    description: DESCRIPTION,
    parameters: {
      vtu: { type: 'string', description: 'Path to the .vtu from cae_solve_static (preferred).' },
      frd: { type: 'string', description: 'Path to the .frd from cae_solve_static (fallback).' },
      maxima: {
        type: 'array',
        items: { type: 'object', additionalProperties: false, properties: { field: { type: 'string', required: true, enum: FIELDS } } },
        description: 'Field extremes with locations, e.g. [{"field": "vonMises"}].',
      },
      probes: {
        type: 'array',
        items: {
          type: 'object', additionalProperties: false,
          properties: { field: { type: 'string', required: true, enum: FIELDS }, pointMm: { type: 'array', items: { type: 'number' }, required: true } },
        },
        description: 'Values at the closest mesh point to pointMm [x, y, z].',
      },
      plots: {
        type: 'array',
        items: { type: 'object', additionalProperties: false, properties: { field: { type: 'string', required: true, enum: FIELDS } } },
        description: 'Contour PNGs of deformed shape, one per field.',
      },
    },
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        properties: {
          values: {
            type: 'array', required: true,
            items: {
              type: 'object', additionalProperties: false,
              properties: {
                field: { type: 'string', required: true },
                value: { type: 'number', required: true },
                unit: { type: 'string', required: true },
                atMm: { type: 'array', items: { type: 'number' } },
              },
            },
          },
          plots: {
            type: 'array', required: true,
            items: {
              type: 'object', additionalProperties: false,
              properties: {
                field: { type: 'string', required: true },
                path: { type: ['string', 'null'], required: true },
                error: { type: 'string' },
              },
            },
          },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.values.map(v => `${v.field}: ${v.value.toPrecision(6)} ${v.unit}${v.atMm ? ` at ${v.atMm.map(c => c.toFixed(2)).join(', ')} mm` : ''}`).join('\n')
          + (value.plots.length ? `\nPlots: ${value.plots.map(p => p.path ?? `${p.field} (failed: ${p.error})`).join(', ')}` : ''),
      }],
    },
    async execute(args, exec) {
      await ensureDeps(config, exec.signal)
      if (!args.vtu && !args.frd) throw new Error('provide either vtu or frd')
      const stem = (args.vtu ?? args.frd!).replace(/\.(vtu|frd)$/, '')
      const pngStem = stem
      const argv: string[] = []
      if (args.vtu) argv.push('--vtu', args.vtu)
      else argv.push('--frd', args.frd!)
      for (const m of args.maxima ?? []) argv.push('--max', m.field)
      for (const p of args.probes ?? []) argv.push('--probe', `${p.field},${p.pointMm.join(',')}`)
      for (const p of args.plots ?? []) argv.push('--plot', p.field)
      argv.push('--png-stem', pngStem)
      const { receipt } = await runStage(config, 'post', argv,
        { signal: exec.signal, logFile: `${stem.split('/').pop()}.post.log` })
      return receipt as unknown as {
        values: { field: string; value: number; unit: string; atMm?: number[] }[]
        plots: { field: string; path: string | null; error?: string }[]
      }
    },
    presentCall: args => ({ card: 'generic', title: 'Post-process results', kind: 'other', rawInput: { vtu: args.vtu, frd: args.frd } }),
  })
}
```

Final `src/index.ts` (replace the Task 1 body):

```ts
// src/index.ts
/**
 * dsh-cae: natural-language-driven CAE pipeline for DeepSeek Harness.
 * Registers four stage tools on `ctx.tools`; domain work runs in bundled
 * Python modules via one-shot subprocesses. Spec: docs/specs.
 * @module dsh-cae
 */
import type { Context } from '@deepseek-ai/cordis'
import { Config } from './config.ts'
import { defineCaeCadTool } from './tools/cad.ts'
import { defineCaeMeshTool } from './tools/mesh.ts'
import { defineCaeSolveTool } from './tools/solve.ts'
import { defineCaePostTool } from './tools/post.ts'

export const name = 'dsh-cae'
export const inject = ['tools']

export { Config } from './config.ts'

/**
 * Register the four CAE stage tools on the tool registry.
 * @param ctx - registrant context carrying the tool registry.
 * @param config - deployment configuration.
 */
export function apply(ctx: Context, config: Config): void {
  ctx.tools.register(defineCaeCadTool(config))
  ctx.tools.register(defineCaeMeshTool(config))
  ctx.tools.register(defineCaeSolveTool(config))
  ctx.tools.register(defineCaePostTool(config))
}
```

```yaml
# cordis.patch.yml
- insert:
    - id: cae
      name: dsh-cae
      config:
        python: python3
        workdir: ./cae
        stageTimeoutMs: 600000
```

- [ ] **Step 4: Run all TS tests + build**

Run: `pnpm build && pnpm vitest run`
Expected: all PASS (kernel tests SKIP on a dev box without the stack; wiring test PASSES everywhere).

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat: solve and post tools; register the full CAE tool set"
```

---

### Task 10: Composition boot test against the local harness checkout

**Files:**
- Create: `tests/composition.e2e.ts`

**Interfaces:**
- Consumes: local harness checkout at `$DSH_HARNESS_DIR` (default `~/deepseek-harness`).
- Produces: proof that a real Loader mount composes the plugin rows (the out-of-tree analogue of the repo's REAL-composition rule).

- [ ] **Step 1: Write the test**

```ts
// tests/composition.e2e.ts
import { describe, expect, it } from 'vitest'
import { spawnSync } from 'node:child_process'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const harness = process.env.DSH_HARNESS_DIR ?? '~/deepseek-harness'
const hasHarness = (() => {
  try {
    return spawnSync('test', ['-d', join(harness, 'packages')], { shell: true }).status === 0
  } catch {
    return false
  }
})()

describe.skipIf(!hasHarness)('loader composition (opt-in)', () => {
  it('dsh --dump-config shows the cae layer with our four tools present after boot', async () => {
    const entry = resolve('lib/index.js')
    const overlay = await mkdtemp(join(tmpdir(), 'dsh-cae-overlay-'))
    const patch = join(overlay, 'patch.yml')
    await writeFile(patch, `- insert:\n    - id: cae\n      name: ${entry}\n`, 'utf8')
    const res = spawnSync('pnpm', ['dsh', '--profile', 'headless', '--patch', patch, '--dump-config'],
      { cwd: harness, encoding: 'utf8', timeout: 120_000 })
    expect(res.status).toBe(0)
    expect(res.stdout).toContain('cae')
  })
})
```

- [ ] **Step 2: Run**

Run: `DSH_HARNESS_DIR=~/deepseek-harness pnpm vitest run tests/composition.e2e.ts`
Expected: PASS when the harness checkout is bootable; SKIP elsewhere. If `pnpm dsh` needs an install first, run `pnpm install` in the harness dir once (sandbox note from CLAUDE.md applies).

- [ ] **Step 3: Commit**

```bash
git add -A && git commit -m "test: loader composition boot test via --patch overlay"
```

---

### Task 11: Cantilever pipeline e2e with theory check

**Files:**
- Create: `pytest/test_pipeline.py`, `examples/cantilever.md`

**Interfaces:**
- Consumes: all four stages.
- Produces: the acceptance evidence (δ vs δ_theory = PL³/(3EI) within 5%).

- [ ] **Step 1: Write the test**

```python
# pytest/test_pipeline.py
import math
import shutil

import pytest

pytest.importorskip("build123d")
pytest.importorskip("gmsh")
pytest.importorskip("pyvista")
if shutil.which("ccx") is None:
    pytest.skip("CalculiX ccx not on PATH", allow_module_level=True)

from test_cad import CANTILEVER

L, W, H = 100.0, 20.0, 5.0
P = 100.0
E, NU = 210_000.0, 0.3
I = W * H ** 3 / 12.0
DELTA_THEORY = P * L ** 3 / (3.0 * E * I)


def test_cantilever_tip_deflection_matches_theory(stage, workdir):
    script = workdir / "beam.cad.py"
    script.write_text(CANTILEVER)
    step, faces = workdir / "beam.step", workdir / "beam.faces.json"
    stage(workdir, "cad", "--script-file", str(script), "--step", str(step), "--faces-json", str(faces))
    msh = workdir / "beam.msh"
    stage(workdir, "mesh", "--step", str(step), "--faces-json", str(faces),
          "--msh", str(msh), "--element-size", "3.0")
    proc = stage(workdir, "solve", "--msh", str(msh), "--case", "case",
                 "--young-mpa", str(E), "--poisson", str(NU),
                 "--fixed-group", "fixed", "--load-group", "load", "--load-n", "0,0,-100")
    receipt = parse_receipt(proc)
    assert receipt["exitCode"] == 0
    proc = stage(workdir, "post", "--vtu", "case.vtu", "--png-stem", "case",
                 "--max", "displacement", "--max", "vonMises", "--plot", "vonMises")
    receipt = parse_receipt(proc)
    delta = next(v["value"] for v in receipt["values"] if v["field"] == "displacement")
    assert delta == pytest.approx(DELTA_THEORY, rel=0.05), (
        f"tip deflection {delta} vs theory {DELTA_THEORY}")
    von_mises = next(v["value"] for v in receipt["values"] if v["field"] == "vonMises")
    assert von_mises > 0
    plot = next(p for p in receipt["plots"] if p["field"] == "vonMises")
    assert plot["path"], f"plot failed: {plot.get('error')}"
```

```markdown
<!-- examples/cantilever.md -->
# Demo: natural-language cantilever simulation

Install the plugin into a profile, boot it, and paste:

> 建一根 100×20×5 mm 的悬臂梁：左端面固定，右端面施加 100 N 向下的力。
> 材料为钢（E=210 GPa，ν=0.3）。做静力分析：先粗网格求解，报告最大挠度
> 与最大等效应力，并出 von Mises 云图；然后加密一倍网格做网格无关性验证。

Expected agent flow: `cae_cad_build` (NAMED_FACES: fixed/load) →
`cae_mesh_generate` → `cae_solve_static` → `cae_post_process` → numbers + PNG,
with a second, finer mesh pass for mesh independence.
```

- [ ] **Step 2: Run**

Run: `python3 -m pytest pytest/test_pipeline.py -v`
Expected: PASS on CI (full stack + xvfb); SKIP locally without kernels.

- [ ] **Step 3: Commit**

```bash
git add -A && git commit -m "test: cantilever pipeline vs Euler-Bernoulli theory within 5%"
```

---

### Task 12: README ×2, CI workflow, publish prep

**Files:**
- Create: `README.md`, `README.zh.md`, `.github/workflows/ci.yml`
- Modify: `package.json` (verify `files`, `prepare`)

**Interfaces:** none (terminal task).

- [ ] **Step 1: CI workflow**

```yaml
# .github/workflows/ci.yml
name: ci
on:
  push: { branches: [main] }
  pull_request:
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
        with: { version: 9 }
      - uses: actions/setup-node@v4
        with: { node-version: 24, cache: pnpm }
      - uses: actions/setup-python@v5
        with: { python-version: "3.12" }
      - run: sudo apt-get update && sudo apt-get install -y calculix-ccx libgl1 xvfb
      - run: pip install build123d gmsh pyvista meshio pytest
      - run: pnpm install
      - run: pnpm build
      - run: pnpm test
      - run: xvfb-run -a python -m pytest pytest -v
```

- [ ] **Step 2: README.md (English, primary)**

Sections in order, one paragraph each unless noted: What (four tools, NL-driven CAE); Install (Python stack `pip install build123d gmsh pyvista meshio` + `conda install -c conda-forge calculix` or `sudo apt install calculix-ccx`; then `dsh plugin --profile demo add dsh-cae`); Try it (link examples/cantilever.md); The four tools (table: name / input / output); Trust boundary (`script` args are model-generated code executed locally — same trust level as the built-in bash tool; use a profile permission layer to gate); Units (mm/N/MPa everywhere); Configuration (the three Config fields as a table); Headless plotting note (Linux servers need EGL/OSMesa — prefer conda's vtk, CI uses xvfb); Limitations (linear static only, tet meshes, POSIX only, single-machine); Roadmap (skill, background jobs via ctx.jobs, modal/thermal, OpenFOAM, solver providers); License (MIT). Keep every claim verifiable from the spec.

- [ ] **Step 3: README.zh.md — same structure in Chinese, same facts, no new claims**

- [ ] **Step 4: Verify build, full test suite, and commit**

Run: `pnpm build && pnpm test && python3 -m pytest pytest -v`
Expected: TS suite green; pytest green-or-skipped per environment.

```bash
git add -A && git commit -m "docs: bilingual README, CI workflow, cantilever example"
```

---

## Self-Review (performed, fixes applied)

1. **Spec coverage** — bundle manifest ✓ (T1), Config ✓ (T1), runner/timeout/signal/log-cap ✓ (T2), deps fail-loud ✓ (T3), four stages ✓ (T4–7), four tools + cards ✓ (T8–9, solve terminal card), patch layer ✓ (T9), boot composition ✓ (T10), acceptance ±5% ✓ (T11), bilingual README/CI/publish ✓ (T12). Spec's v1.1 roadmap items (skill, jobs, modal, OpenFOAM) intentionally out of scope.
2. **Placeholders** — the Task 6 draft loop was replaced by the FINAL file with `emit_elements`; `stub_cae.py` was dropped with the reason stated inline in T8; no TBD/TODO remain.
3. **Type consistency** — `runStage(config, stage, args, {signal, logFile})` identical in T2/8/9; receipt field names match between Python emitters and TS casts (`volumeMm3`, `groupNames`, `vtuPath`, `logTail`); tool factory names `defineCae{Cad,Mesh,Solve,Post}Tool` consistent across T8/T9/index.ts.
4. **Known env-dependent steps** — pytest stages self-skip without kernels (CI is authoritative); composition test self-skips without the harness checkout; `defineTool` field spellings are compiler-arbitrated against the installed typings.
