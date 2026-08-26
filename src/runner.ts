import { spawn } from 'node:child_process'
import { mkdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import type { Config } from './config.js'
import { INSTALL_HINTS, depsFailureMessage, pythonFor, stageEnv } from './interpreter.js'

export { pythonDir } from './interpreter.js'

/** Marker line preceding the stage receipt on stdout. */
export const RECEIPT_MARK = '<<<DSH_CAE_JSON>>>'
/** Cap on combined output kept for error messages and canonical log tails. */
const TAIL_BYTES = 8192
/** Grace period between SIGTERM and SIGKILL of the stage process group. */
const KILL_GRACE_MS = 2000

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
  opts: { signal?: AbortSignal | undefined; logFile: string },
): Promise<StageOutcome> {
  const workdir = resolve(config.workdir)
  await mkdir(workdir, { recursive: true })
  const logPath = resolve(workdir, opts.logFile)
  const python = pythonFor(config)
  const proc = spawn(python, ['-m', `dsh_cae.${stage}`, ...args], {
    cwd: workdir,
    detached: true,
    env: stageEnv(python, process.env),
    stdio: ['ignore', 'pipe', 'pipe'],
  })

  let stdout = ''
  let stderr = ''
  proc.stdout.on('data', (chunk: Buffer) => { stdout += chunk })
  proc.stderr.on('data', (chunk: Buffer) => { stderr += chunk })

  let timedOut = false
  let timeout: NodeJS.Timeout | undefined
  let grace: NodeJS.Timeout | undefined
  let abort = (): void => {}
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
    timeout = setTimeout(() => { timedOut = true; killGroup() }, config.stageTimeoutMs)
  }

  const code: number | null = await new Promise((resolveCode) => {
    proc.once('close', resolveCode)
  })
  clearTimeout(timeout)
  clearTimeout(grace)
  opts.signal?.removeEventListener('abort', abort)

  const combined = stdout + (stderr ? `\n[stderr]\n${stderr}` : '')
  await writeFile(logPath, combined, 'utf8')

  const failInfra = (why: string): Error =>
    new Error(`dsh-cae stage '${stage}' ${why}\n${tail(combined)}`)
  if (timedOut) throw failInfra(`timed out after ${config.stageTimeoutMs}ms`)
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

/** Dependency group a tool chain needs before its stages may run. */
export type DepsGroup = 'structural' | 'cfd'

/** Cached verdicts of the interpreter dependency self-check, per group. */
const depsOk = new WeakMap<Config, Set<DepsGroup>>()

/**
 * Verify once per config object and group that the stage dependencies are
 * present; throws with the exact install hint on the first missing set.
 * @param config - deployment configuration.
 * @param signal - abort signal forwarded to the check subprocess.
 * @param group - dependency set: 'structural' (default) or 'cfd'.
 */
export async function ensureDeps(
  config: Config, signal?: AbortSignal, group: DepsGroup = 'structural',
): Promise<void> {
  const seen = depsOk.get(config) ?? new Set<DepsGroup>()
  depsOk.set(config, seen)
  if (seen.has(group)) return
  const argv = ['--group', group]
  if (group === 'cfd' && config.openfoamBashrc) argv.push('--bashrc', config.openfoamBashrc)
  const { receipt } = await runStage(config, 'deps', argv, {
    signal, logFile: `deps.${group}.log`,
  }).catch((error: Error) => {
    throw new Error(
      `dsh-cae cannot start its Python stages with interpreter '${pythonFor(config)}': `
      + `${error.message}\n${INSTALL_HINTS[group]}`,
    )
  })
  if (receipt.ok !== true) {
    throw new Error(depsFailureMessage(group, receipt))
  }
  seen.add(group)
}
