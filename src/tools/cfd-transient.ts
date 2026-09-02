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
      writeIntervalS: { type: 'number', description: 'Result write interval in simulated seconds; must divide endTimeS evenly so the final time is written. Default endTimeS/10.' },
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
      // foamRun overshoots a non-divisor endTime (adjustableRunTime never lands
      // on it) and the final state is never written — foamToVTK then converts an
      // earlier time while the receipt still reports endTimeS.
      const ratio = endTimeS / writeIntervalS
      if (Math.abs(ratio - Math.round(ratio)) > 1e-9) {
        throw new Error(
          `writeIntervalS ${writeIntervalS} does not divide endTimeS ${endTimeS} — `
          + 'choose a writeIntervalS that divides endTimeS evenly so the final time is written')
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
