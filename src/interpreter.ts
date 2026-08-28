/** Interpreter resolution and spawn-environment sanitation for Python stages. */
import { spawnSync } from 'node:child_process'
import { accessSync, constants } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/** Config value meaning "probe a dsh-cae conda env, else python3". */
export const AUTO_PYTHON = 'auto'

/** Conda environment name a dsh-cae deployment is expected to live in. */
const ENV_NAME = 'dsh-cae'

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
 * Absolute path of the shipped `python/` directory. Resolves identically from
 * `src/` (tsx source launch) and `lib/` (built install) because both sit one
 * level below the package root.
 * @returns directory containing the `dsh_cae` package.
 */
export function pythonDir(): string {
  return join(dirname(fileURLToPath(import.meta.url)), '..', 'python')
}

/** True when `path` exists and is executable. */
function isExecutable(path: string): boolean {
  try {
    accessSync(path, constants.X_OK)
    return true
  } catch {
    return false
  }
}

/** True when `path` is readable (used as a cheap directory probe). */
function isDir(path: string): boolean {
  try {
    accessSync(path, constants.R_OK)
    return true
  } catch {
    return false
  }
}

/**
 * Candidate conda-style env directories that may hold a `dsh-cae` deployment:
 * the active `$CONDA_PREFIX` when it is itself the dsh-cae env, then every
 * root named by `$CONDA_ENVS_PATH`, then the conventional install roots.
 * @param home - home directory override for tests.
 * @param env - environment override for tests.
 * @returns env directories in probe order, deduplicated.
 */
export function defaultEnvCandidates(
  home: string = homedir(),
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  const candidates: string[] = []
  if (env.CONDA_PREFIX && resolve(env.CONDA_PREFIX).split('/').pop() === ENV_NAME) {
    candidates.push(env.CONDA_PREFIX)
  }
  if (env.CONDA_ENVS_PATH) {
    for (const root of env.CONDA_ENVS_PATH.split(':')) {
      if (root) candidates.push(join(root, ENV_NAME))
    }
  }
  const roots = [
    join(home, '.conda', 'envs'),
    join(home, 'miniconda3', 'envs'),
    join(home, 'anaconda3', 'envs'),
    join(home, 'mambaforge', 'envs'),
    '/opt/conda/envs',
  ]
  for (const root of roots) candidates.push(join(root, ENV_NAME))
  return [...new Set(candidates)]
}

/**
 * Resolve the configured interpreter. `'auto'` probes the candidate conda envs
 * for an executable `bin/python` and falls back to `python3`; any other value
 * is an explicit user choice and is returned untouched.
 * @param configured - the `python` config value.
 * @param candidates - env directories to probe (defaults to {@link defaultEnvCandidates}).
 * @returns interpreter path or command to spawn.
 */
export function resolvePython(configured: string, candidates: string[] = defaultEnvCandidates()): string {
  if (configured !== AUTO_PYTHON) return configured
  for (const envDir of candidates) {
    const python = join(envDir, 'bin', 'python')
    if (isExecutable(python)) return python
  }
  return 'python3'
}

/** Memoized resolution per config object, so probing happens once per plugin. */
const resolved = new WeakMap<object, { python: string }>()

/**
 * Resolve `config.python` once per config object.
 * @param config - deployment configuration.
 * @returns interpreter path or command to spawn.
 */
export function pythonFor(config: { python: string }): string {
  let hit = resolved.get(config)
  if (hit === undefined) {
    hit = { python: resolvePython(config.python) }
    resolved.set(config, hit)
  }
  return hit.python
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

/**
 * Build the spawn environment for a Python stage: the shipped `python/` dir on
 * PYTHONPATH, and — for a conda-style interpreter (marked by a `conda-meta`
 * sibling) — the env's own `lib` prepended to LD_LIBRARY_PATH. The prepend is
 * the fix for environments where an injected LD_LIBRARY_PATH (e.g. OpenFOAM's
 * bashrc listing /usr/lib/…) shadows the interpreter's newer bundled libs,
 * which surfaces as pyexpat "undefined symbol" import errors.
 * @param python - resolved interpreter path or command.
 * @param parent - environment to inherit.
 * @returns environment for the stage subprocess.
 */
export function stageEnv(python: string, parent: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...parent,
    PYTHONPATH: [pythonDir(), parent.PYTHONPATH].filter(Boolean).join(':'),
  }
  if (process.platform !== 'win32') {
    const envRoot = resolve(python, '..', '..')
    if (isDir(join(envRoot, 'conda-meta'))) {
      env.LD_LIBRARY_PATH = [join(envRoot, 'lib'), parent.LD_LIBRARY_PATH].filter(Boolean).join(':')
      // bin first so the deps check and solve stages find the env's own ccx
      env.PATH = [join(envRoot, 'bin'), parent.PATH].filter(Boolean).join(':')
    }
  }
  return env
}

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

/** Install hints per dependency group. */
export const INSTALL_HINTS = {
  structural:
    'Install with:\n  pip install build123d gmsh pyvista ccx2paraview\n'
    + '  conda install -c conda-forge calculix  # or: sudo apt install calculix-ccx',
  cfd:
    'Install OpenFOAM (https://openfoam.org/download), or point openfoamBashrc/FOAM_BASHRC '
    + 'at an existing etc/bashrc (auto-checked: /opt/openfoam*/etc/bashrc, /usr/lib/openfoam/*/etc/bashrc)',
} as const

/**
 * Format the deps-incomplete error from a deps receipt, surfacing the
 * diagnostics when present: which interpreter ran the check and why each
 * import actually failed (installed-but-broken beats missing-package).
 * @param group - dependency set that failed.
 * @param receipt - the deps stage receipt (`ok !== true`).
 * @returns multi-line error message ending in the install hint.
 */
export function depsFailureMessage(
  group: 'structural' | 'cfd',
  receipt: Record<string, unknown>,
): string {
  const lines = [`dsh-cae ${group} dependencies are incomplete (missing: ${JSON.stringify(receipt.missing ?? [])}).`]
  const diag = receipt.diagnostics as
    | { python?: string, pythonVersion?: string, importErrors?: Record<string, string> }
    | undefined
  if (diag?.python) {
    lines.push(`interpreter: ${diag.python}${diag.pythonVersion ? ` (${diag.pythonVersion})` : ''}`)
    const errors = Object.entries(diag.importErrors ?? {})
    if (errors.length > 0) {
      lines.push('import errors:')
      for (const [mod, err] of errors) lines.push(`  ${mod}: ${err}`)
      lines.push(
        'import errors on installed packages usually mean a broken environment '
        + '(e.g. LD_LIBRARY_PATH shadowing the interpreter\'s own libs), not a missing package',
      )
    }
  }
  lines.push(INSTALL_HINTS[group])
  return lines.join('\n')
}
