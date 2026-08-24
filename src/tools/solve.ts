import { join, resolve } from 'node:path'
import { writeFile } from 'node:fs/promises'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { ensureDeps, runStage } from '../runner.js'
import type { Config } from '../config.js'

const DESCRIPTION =
  'Run a CalculiX linear static solve on a mesh. Units: mm, N, MPa. Fix surfaces by '
  + 'group name from cae_cad_build NAMED_FACES; apply forces as total vectors [fx, fy, fz] '
  + 'spread over a group. A NON-ZERO exitCode in the result is a domain outcome (e.g. '
  + 'divergence, singular matrix): read logTail, adjust mesh/loads/boundary conditions, retry. '
  + 'Returns deck/result paths and wall time; vtuPath is null when FRD conversion failed '
  + '(frdPath stays usable).'

/** Receipt shape of the `solve` stage, pinned for the tool's output schema. */
export interface SolveReceipt {
  inpPath: string
  frdPath: string
  vtuPath: string | null
  exitCode: number
  wallMs: number
  logTail: string
}

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
          properties: {
            groupName: { type: 'string', required: true },
            kind: { type: 'string', required: true, enum: ['fixed'] },
          },
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
          vtuPath: { oneOf: [{ type: 'string' }, { type: 'null' }], required: true },
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
      if (stem.includes('/') || stem.includes('\\')) {
        throw new Error(`case stem '${stem}' must not contain path separators`)
      }
      const dir = resolve(config.workdir)
      const casePath = join(dir, stem)
      const argv = ['--msh', args.msh, '--case', casePath,
        '--young-mpa', String(args.material.youngMPa), '--poisson', String(args.material.poisson)]
      for (const c of args.constraints) {
        if (c.kind !== 'fixed') throw new Error(`unsupported constraint kind '${c.kind}'`)
        argv.push('--fixed-group', c.groupName)
      }
      for (const l of args.loads) {
        argv.push('--load-group', l.groupName, '--load-n', l.vectorN.join(','))
      }
      if (args.script) {
        const scriptFile = join(dir, `${stem}.patch.inp`)
        await writeFile(scriptFile, args.script, 'utf8')
        argv.push('--script-file', scriptFile)
      }
      const { receipt } = await runStage(config, 'solve', argv,
        { signal: exec.signal, logFile: `${stem}.solve.log` })
      return receipt as unknown as SolveReceipt
    },
    presentCall: args => ({ card: 'terminal', title: `ccx ${args.case ?? 'case'}`, description: 'CalculiX static solve' }),
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
