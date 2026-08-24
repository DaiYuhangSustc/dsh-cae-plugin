import { basename, resolve } from 'node:path'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { ensureDeps, runStage } from '../runner.js'
import type { Config } from '../config.js'

const DESCRIPTION =
  'Extract numbers and render contour plots from a solve result (VTU preferred, FRD '
  + 'fallback). Structural units: mm displacement, MPa stress. CFD results (from '
  + 'cae_cfd_steady .vtk): velocity in m/s, pressure in Pa — pass densityKgM3 '
  + '(e.g. 1000 for water) to convert kinematic pressure. Fields: displacement, '
  + 'vonMises, stressXX/YY/ZZ/XY/YZ/XZ, velocity, pressure. `max` returns the field '
  + 'extreme with its location; `probe` returns the value at the closest point to '
  + '[x, y, z] in the result file\'s length unit (mm structural, m CFD); `plot` writes '
  + 'a contour PNG (deformed shape for structural fields) for the human (you cannot '
  + 'see it — quote the numbers).'

const FIELDS = ['displacement', 'vonMises', 'stressXX', 'stressYY', 'stressZZ', 'stressXY', 'stressYZ', 'stressXZ', 'velocity', 'pressure']

/** One extracted number: a field extreme (`kind: 'max'`) or probe value. */
export interface PostValue {
  kind: 'max' | 'probe'
  field: string
  value: number
  unit: string
  atMm?: number[]
  atM?: number[]
}

/** Receipt shape of the `post` stage, pinned for the tool's output schema. */
export interface PostReceipt {
  values: PostValue[]
  plots: { field: string; path: string | null; error?: string }[]
}

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
          properties: { field: { type: 'string', required: true, enum: FIELDS }, point: { type: 'array', items: { type: 'number' }, required: true } },
        },
        description: 'Values at the closest mesh point to point [x, y, z] in the result file\'s length unit (mm structural, m CFD).',
      },
      plots: {
        type: 'array',
        items: { type: 'object', additionalProperties: false, properties: { field: { type: 'string', required: true, enum: FIELDS } } },
        description: 'Contour PNGs of deformed shape, one per field.',
      },
      densityKgM3: { type: 'number', description: 'Density kg/m³ multiplied into pressure to convert the CFD kinematic p to Pa. Default 1.' },
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
                kind: { type: 'string', required: true, enum: ['max', 'probe'] },
                field: { type: 'string', required: true },
                value: { type: 'number', required: true },
                unit: { type: 'string', required: true },
                atMm: { type: 'array', items: { type: 'number' } },
                atM: { type: 'array', items: { type: 'number' } },
              },
            },
          },
          plots: {
            type: 'array', required: true,
            items: {
              type: 'object', additionalProperties: false,
              properties: {
                field: { type: 'string', required: true },
                path: { oneOf: [{ type: 'string' }, { type: 'null' }], required: true },
                error: { type: 'string' },
              },
            },
          },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.values.map(v => `${v.field}: ${v.value.toPrecision(6)} ${v.unit}${v.atMm ? ` at ${v.atMm.map(c => c.toFixed(2)).join(', ')} mm` : v.atM ? ` at ${v.atM.map(c => c.toFixed(3)).join(', ')} m` : ''}`).join('\n')
          + (value.plots.length ? `\nPlots: ${value.plots.map(p => p.path ?? `${p.field} (failed: ${p.error})`).join(', ')}` : ''),
      }],
    },
    async execute(args, exec) {
      if (args.vtu && args.frd) throw new Error('provide either vtu or frd, not both')
      if (!args.vtu && !args.frd) throw new Error('provide either vtu or frd')
      const vtu = args.vtu ? resolve(args.vtu) : undefined
      const frd = args.frd ? resolve(args.frd) : undefined
      await ensureDeps(config, exec.signal)
      const pngStem = (vtu ?? frd!).replace(/\.(vtu|frd)$/, '')
      const argv: string[] = []
      if (vtu) argv.push('--vtu', vtu)
      else argv.push('--frd', frd!)
      for (const m of args.maxima ?? []) argv.push('--max', m.field)
      for (const p of args.probes ?? []) argv.push('--probe', `${p.field},${p.point.join(',')}`)
      for (const p of args.plots ?? []) argv.push('--plot', p.field)
      if (args.densityKgM3 !== undefined) argv.push('--density-kg-m3', String(args.densityKgM3))
      argv.push('--png-stem', pngStem)
      const { receipt } = await runStage(config, 'post', argv,
        { signal: exec.signal, logFile: `${basename(pngStem)}.post.log` })
      return receipt as unknown as PostReceipt
    },
    presentCall: args => ({ card: 'generic', title: 'Post-process results', kind: 'other', rawInput: { vtu: args.vtu, frd: args.frd } }),
  })
}
