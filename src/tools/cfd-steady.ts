import { join, resolve } from 'node:path'
import { access, writeFile } from 'node:fs/promises'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { ensureDeps, runStage } from '../runner.js'
import type { Config } from '../config.js'

const DESCRIPTION =
  'Run a steady incompressible laminar solve (simpleFoam-successor foamRun) on a cae_cfd_mesh case. '
  + 'SI units: velocity m/s, kinematic viscosity m²/s, density kg/m³. A converged=false result is '
  + 'a normal outcome: raise iterations or override system/fvSolution\'s SIMPLE block (e.g. looser '
  + 'residualControl) and retry; exitCode!=0 carries logTail for diagnosis. densityKgM3 is echoed — '
  + 'pass the same value to cae_post_process so kinematic pressure converts to Pa. overrides replace '
  + 'top-level entries in whitelisted case dicts, exactly and only.'

const OVERRIDE_FILES = [
  'system/controlDict', 'system/fvSchemes', 'system/fvSolution',
  'system/blockMeshDict', 'constant/physicalProperties', 'constant/momentumTransport',
] as const

/** Receipt shape of the `cfd_steady` stage, pinned for the tool's output schema. */
export interface CfdSteadyReceipt {
  caseDir: string
  logPath: string
  vtkPath: string | null
  iterationsRun: number
  converged: boolean
  finalResiduals: { p: number | null; U: number | null }
  wallMs: number
  exitCode: number
  logTail: string
  densityKgM3: number
}

/** Build the `cae_cfd_steady` tool bound to one deployment configuration. */
export function defineCaeCfdSteadyTool(config: Config) {
  return defineTool({
    name: 'cae_cfd_steady',
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
      densityKgM3: { type: 'number', description: 'Density kg/m³, echoed for cae_post_process. Default 1.' },
      iterations: { type: 'integer', description: 'Iteration (endTime) cap. Default 2000.' },
      overrides: {
        type: 'array',
        items: {
          type: 'object', additionalProperties: false,
          properties: {
            file: { type: 'string', required: true, enum: [...OVERRIDE_FILES] },
            entry: { type: 'string', required: true, description: 'Top-level entry to replace, e.g. endTime or SIMPLE.' },
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
          iterationsRun: { type: 'integer', required: true },
          converged: { type: 'boolean', required: true },
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
        text: `foamRun exit ${value.exitCode} — `
          + (value.converged
            ? `converged in ${value.iterationsRun} iterations`
            : `NOT converged after ${value.iterationsRun} iterations (p ${value.finalResiduals.p ?? 'n/a'}, `
              + `U ${value.finalResiduals.U ?? 'n/a'}) — raise iterations or override SIMPLE`)
          + `. Results: ${value.vtkPath ?? value.logPath}`,
      }],
      presentationMeta: (_args, value) => ({ exitCode: value.exitCode, logTail: value.logTail }),
    },
    async execute(args, exec) {
      if (args.inletVelocityMS.length !== 3) {
        throw new Error(`inletVelocityMS must be [u, v, w], got ${JSON.stringify(args.inletVelocityMS)}`)
      }
      const iterations = args.iterations ?? 2000
      if (!Number.isInteger(iterations) || iterations <= 0) {
        throw new Error(`iterations must be a positive integer, got ${iterations}`)
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
        '--iterations', String(iterations),
        '--case', stem,
      ]
      if (args.overrides?.length) {
        const ovrFile = join(caseDir, `${stem}.overrides.json`)
        await writeFile(ovrFile, JSON.stringify(args.overrides), 'utf8')
        argv.push('--overrides-file', ovrFile)
      }
      if (config.openfoamBashrc) argv.push('--bashrc', config.openfoamBashrc)
      const { receipt } = await runStage(config, 'cfd_steady', argv,
        { signal: exec.signal, logFile: `cfd.${stem}.steady.log` })
      return receipt as unknown as CfdSteadyReceipt
    },
    presentCall: args => ({ card: 'terminal', title: `foamRun ${args.case ?? 'run'}`, description: 'Steady incompressible solve' }),
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
