// src/tools/verify-mesh.ts
import { join, resolve } from 'node:path'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { InferArgs, ParameterSchemaSpec } from '@deepseek-ai/dsh-tools'
import { ensureDeps, runStage } from '../runner.js'
import { runtimeFor } from '../interpreter.js'
import { gci } from '../gci.js'
import type { GciLevel } from '../gci.js'
import type { Config } from '../config.js'

const DESCRIPTION =
  'Mesh-independence study (stage-5 verification): re-mesh at 3+ sizes, run the identical '
  + 'solve at every level, extract one monitored metric, and report the Richardson observed '
  + 'order + GCI (Celik 2008) with a threshold verdict. chain="structural" needs the same '
  + 'inputs as cae_solve_static plus elementSizesMm; chain="cfd" re-meshes the parametric duct '
  + 'at cellSizesMm and runs cae_cfd_steady per level. This is the MOST EXPENSIVE tool — a '
  + 'full mesh+solve per size. A CFD level that does not converge fails the study (loosen '
  + 'SIMPLE residualControl via cae_cfd_steady retries first); oscillatory convergence reports '
  + 'meshIndependent=false because the numbers cannot be trusted. meshIndependent=true when the '
  + 'fine-grid GCI is within gciThresholdPercent (default 3%).'

/** Receipt of cae_verify_mesh: per-level table + the GCI study + a verdict. */
export interface VerifyMeshReceipt {
  chain: 'structural' | 'cfd'
  metric: string
  levels: { sizeMm: number; count: number; metricValue: number }[]
  refinementRatios: { r21: number; r32: number }
  convergenceState: 'monotonic' | 'oscillatory'
  observedOrder: number | null
  richardsonExtrapolated: number | null
  gciFinePercent: number | null
  gciCoarsePercent: number | null
  meshIndependent: boolean
  thresholdPercent: number
  recommendation: string
}

type LevelRow = VerifyMeshReceipt['levels'][number]

/** The `cae_verify_mesh` parameter schema (hoisted so InferArgs can see it). */
const PARAMETERS = {
      chain: { type: 'string', enum: ['structural', 'cfd'], required: true, description: 'Which chain to study.' },
      elementSizesMm: { type: 'array', items: { type: 'number' }, description: 'structural: ≥3 strictly monotonic element sizes, e.g. [8, 5, 3].' },
      cellSizesMm: { type: 'array', items: { type: 'number' }, description: 'cfd: ≥3 strictly monotonic cell sizes.' },
      metric: {
        type: 'string', enum: ['maxVonMises', 'maxDisplacement', 'maxVelocityMS', 'pressureDropPa'],
        description: 'Monitored scalar. Default maxVonMises (structural) / maxVelocityMS (cfd).',
      },
      gciThresholdPercent: { type: 'number', description: 'Fine-grid GCI percent below which the mesh counts as independent. Default 3.' },
      // structural inputs (mirror cae_solve_static)
      step: { type: 'string', description: 'structural: the .step from cae_cad_build / cae_step_import.' },
      facesJson: { type: 'string', description: 'structural: the faces.json sidecar.' },
      material: {
        type: 'object', additionalProperties: false,
        properties: {
          youngMPa: { type: 'number', required: true },
          poisson: { type: 'number', required: true },
        },
      },
      fixedGroups: { type: 'array', items: { type: 'string' }, description: 'structural: constrained face groups.' },
      loads: {
        type: 'array',
        items: {
          type: 'object', additionalProperties: false,
          properties: {
            group: { type: 'string', required: true },
            forceN: { type: 'array', items: { type: 'number' }, required: true },
          },
        },
      },
      // cfd inputs (mirror cae_cfd_mesh + cae_cfd_steady)
      lengthMm: { type: 'number' },
      widthMm: { type: 'number' },
      heightMm: { type: 'number' },
      wallGrading: { type: 'number' },
      inletVelocityMS: { type: 'array', items: { type: 'number' } },
      kinematicViscosityM2S: { type: 'number' },
      densityKgM3: { type: 'number' },
    } satisfies ParameterSchemaSpec

/** The tool's inferred argument object type. */
type VerifyMeshArgs = InferArgs<typeof PARAMETERS>

/** Build the `cae_verify_mesh` tool bound to one deployment configuration. */
export function defineCaeVerifyMeshTool(config: Config) {
  return defineTool({
    name: 'cae_verify_mesh',
    description: DESCRIPTION,
    parameters: PARAMETERS,
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        properties: {
          chain: { type: 'string', required: true },
          metric: { type: 'string', required: true },
          levels: {
            type: 'array', required: true,
            items: { type: 'object', additionalProperties: false, properties: {
              sizeMm: { type: 'number', required: true },
              count: { type: 'number', required: true },
              metricValue: { type: 'number', required: true },
            } },
          },
          refinementRatios: {
            type: 'object', additionalProperties: false, required: true,
            properties: { r21: { type: 'number', required: true }, r32: { type: 'number', required: true } },
          },
          convergenceState: { type: 'string', enum: ['monotonic', 'oscillatory'], required: true },
          observedOrder: { oneOf: [{ type: 'number' }, { type: 'null' }], required: true },
          richardsonExtrapolated: { oneOf: [{ type: 'number' }, { type: 'null' }], required: true },
          gciFinePercent: { oneOf: [{ type: 'number' }, { type: 'null' }], required: true },
          gciCoarsePercent: { oneOf: [{ type: 'number' }, { type: 'null' }], required: true },
          meshIndependent: { type: 'boolean', required: true },
          thresholdPercent: { type: 'number', required: true },
          recommendation: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: `mesh ${value.meshIndependent ? 'INDEPENDENT' : 'NOT independent'} `
          + `(GCI_fine ${value.gciFinePercent ?? 'n/a'}% vs ${value.thresholdPercent}% threshold, `
          + `order ${value.observedOrder ?? 'n/a'}, ${value.convergenceState}). `
          + `${value.recommendation}`,
      }],
    },
    async execute(args, exec) {
      const isStructural = args.chain === 'structural'
      const sizesRaw = (isStructural ? args.elementSizesMm : args.cellSizesMm) ?? []
      const label = isStructural ? 'elementSizesMm' : 'cellSizesMm'
      if (sizesRaw.length < 3) {
        throw new Error(`need at least 3 ${label} for a GCI study, got ${sizesRaw.length}`)
      }
      if (!sizesRaw.every((s, i) => i === 0 || Math.abs(s - sizesRaw[i - 1]) > 1e-12)
          || new Set(sizesRaw.slice(1).map((s, i) => Math.sign(s - sizesRaw[i]))).size > 1) {
        throw new Error(`${label} must be strictly monotonic`)
      }
      if (isStructural) {
        if (!args.step) throw new Error('chain=structural needs step')
        if (!args.material) throw new Error('chain=structural needs material')
        if (!args.fixedGroups?.length) throw new Error('chain=structural needs at least one fixedGroups entry')
        if (!args.loads?.length) throw new Error('chain=structural needs at least one load')
      } else {
        if (![args.lengthMm, args.widthMm, args.heightMm].every(v => typeof v === 'number')) {
          throw new Error('chain=cfd needs lengthMm, widthMm, heightMm')
        }
        if (!args.inletVelocityMS || !args.kinematicViscosityM2S) {
          throw new Error('chain=cfd needs inletVelocityMS and kinematicViscosityM2S')
        }
      }
      const metric = args.metric ?? (isStructural ? 'maxVonMises' : 'maxVelocityMS')
      const threshold = args.gciThresholdPercent ?? 3
      const workdirAbs = resolve(config.workdir)
      await ensureDeps(config, exec.signal, isStructural ? 'structural' : 'cfd')
      const ordered = [...sizesRaw].sort((a, b) => b - a) // coarsest first

      const levels: LevelRow[] = []
      for (const [i, size] of ordered.entries()) {
        try {
          levels.push(await runLevel(config, exec.signal, args, { workdirAbs, i, size, metric, isStructural }))
        } catch (error) {
          throw new Error(`mesh-independence level ${i + 1} of ${ordered.length} (${size} mm) failed: ${(error as Error).message}`)
        }
      }

      const study = gci(levels.map((l): GciLevel => ({ size: l.sizeMm, count: l.count, value: l.metricValue })), threshold)
      const recommendation = recommend(levels, study.richardsonExtrapolated, threshold)
      return { chain: args.chain, metric, levels, ...study, recommendation } as VerifyMeshReceipt
    },
    presentCall: args => ({
      card: 'terminal', title: 'verify mesh', description: `mesh-independence study (${args.chain}, ${args.elementSizesMm?.length ?? args.cellSizesMm?.length ?? '?'} levels)`,
    }),
  })
}

/** One level: mesh → solve → metric extraction. Returns the level row. */
async function runLevel(
  config: Config, signal: AbortSignal | undefined,
  args: VerifyMeshArgs, ctx: { workdirAbs: string; i: number; size: number; metric: string; isStructural: boolean },
): Promise<LevelRow> {
  const { workdirAbs, i, size, metric, isStructural } = ctx
  if (isStructural) {
    const dir = join(workdirAbs, 'verify', `l${i}`)
    const msh = join(dir, 'part.msh')
    const meshArgv = ['--step', resolve(args.step!), '--msh', msh, '--element-size', String(size)]
    if (args.facesJson) meshArgv.push('--faces-json', resolve(args.facesJson))
    const mesh = await runStage(config, 'mesh', meshArgv, { signal, logFile: `verify.l${i}.mesh.log` })
    const solveArgv = [
      '--msh', msh, '--case', join(dir, 'case'),
      '--young-mpa', String(args.material!.youngMPa),
      '--poisson', String(args.material!.poisson),
      ...args.fixedGroups!.flatMap(g => ['--fixed-group', g]),
      // '=' form: a plain '--load-n -1000,0,0' would be eaten as an option flag
      ...args.loads!.flatMap(l => ['--load-group', l.group, `--load-n=${l.forceN.join(',')}`]),
    ]
    const solve = await runStage(config, 'solve', solveArgv, { signal, logFile: `verify.l${i}.solve.log` })
    const result = solve.receipt.vtuPath ?? solve.receipt.frdPath
    if (!result) throw new Error('solve produced neither vtu nor frd result')
    const field = metric === 'maxVonMises' ? 'vonMises' : 'displacement'
    const postArgv = ['--png-stem', join(dir, 'post'), '--max', field,
                      solve.receipt.vtuPath ? '--vtu' : '--frd', String(result)]
    const post = await runStage(config, 'post', postArgv, { signal, logFile: `verify.l${i}.post.log` })
    const value = (post.receipt.values as { value: number }[])[0]?.value
    if (typeof value !== 'number') throw new Error('post produced no metric value')
    return { sizeMm: size, count: mesh.receipt.nodeCount as number, metricValue: value }
  }

  const name = `verify-l${i}`
  const meshArgv = [
    '--workdir', workdirAbs, '--name', name,
    '--length-mm', String(args.lengthMm!), '--width-mm', String(args.widthMm!),
    '--height-mm', String(args.heightMm!), '--cell-size-mm', String(size),
    '--wall-grading', String(args.wallGrading ?? 1),
  ]
  // Host bashrc paths don't exist inside the container (same guard as the cfd tools).
  if (config.openfoamBashrc && runtimeFor(config).kind !== 'docker') {
    meshArgv.push('--bashrc', config.openfoamBashrc)
  }
  const mesh = await runStage(config, 'cfd_mesh', meshArgv, { signal, logFile: `verify.l${i}.cfd-mesh.log` })
  const cells = mesh.receipt.cells
  if (typeof cells !== 'number') throw new Error('cfd_mesh receipt has no cell count — cannot compute refinement ratios')
  const caseDir = String(mesh.receipt.caseDir)
  const steadyArgv = [
    '--case-dir', caseDir, '--velocity', args.inletVelocityMS!.join(','),
    '--nu', String(args.kinematicViscosityM2S!), '--rho', String(args.densityKgM3 ?? 1),
    '--iterations', '2000', '--case', 'run',
  ]
  if (config.openfoamBashrc && runtimeFor(config).kind !== 'docker') {
    steadyArgv.push('--bashrc', config.openfoamBashrc)
  }
  const steady = await runStage(config, 'cfd_steady', steadyArgv, { signal, logFile: `verify.l${i}.steady.log` })
  if (steady.receipt.converged !== true) {
    throw new Error('cfd_steady did not converge at this level — raise iterations or loosen SIMPLE residualControl before studying mesh independence')
  }
  const vtk = steady.receipt.vtkPath
  if (!vtk) throw new Error('cfd_steady produced no VTK result')
  const stem = join(caseDir, `verify-l${i}`)
  let postArgv: string[]
  let extract: (values: { value: number }[]) => number
  if (metric === 'pressureDropPa') {
    const [L, W, H] = [args.lengthMm! / 1000, args.widthMm! / 1000, args.heightMm! / 1000]
    const eps = size / 2000 // half a cell, meters
    postArgv = ['--vtu', String(vtk), '--png-stem', stem,
                '--probe', `p,${eps},${W / 2},${H / 2}`, '--probe', `p,${L - eps},${W / 2},${H / 2}`,
                '--density-kg-m3', String(args.densityKgM3 ?? 1)]
    extract = values => values[0].value - values[1].value
  } else {
    postArgv = ['--vtu', String(vtk), '--png-stem', stem, '--max', 'velocity']
    extract = values => values[0].value
  }
  const post = await runStage(config, 'post', postArgv, { signal, logFile: `verify.l${i}.post.log` })
  const values = post.receipt.values as { value: number }[]
  if (!values || values.length < (metric === 'pressureDropPa' ? 2 : 1)) throw new Error('post produced no metric value')
  return { sizeMm: size, count: cells, metricValue: extract(values) }
}

/** Coarsest level already within threshold of the extrapolated metric. */
function recommend(levels: LevelRow[], extrapolated: number | null, thresholdPercent: number): string {
  if (extrapolated === null) {
    return 'grid convergence is oscillatory — do not trust any single level; inspect the levels table and refine between levels'
  }
  const pick = levels.find(l => Math.abs(l.metricValue - extrapolated) / Math.abs(extrapolated) * 100 <= thresholdPercent)
  if (!pick) {
    return `no level is within ${thresholdPercent}% of the extrapolated value — refine further and re-run`
  }
  return `${pick.sizeMm} mm is already within ${thresholdPercent}% of the extrapolated metric; finer levels add cost, not accuracy`
}
