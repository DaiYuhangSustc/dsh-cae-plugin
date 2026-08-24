import { join, resolve } from 'node:path'
import { mkdir, writeFile } from 'node:fs/promises'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { ensureDeps, runStage } from '../runner.js'
import type { Config } from '../config.js'

const DESCRIPTION =
  'Generate a CFD mesh for a rectangular duct with blockMesh and validate it with checkMesh. '
  + 'Geometry in mm; the chain converts to SI meters here and stays SI afterwards. Flow along +x, '
  + 'inlet at x-min; patches are named inlet/outlet/walls. Returns caseDir (pass to cae_cfd_steady), '
  + 'cell count, and mesh quality. checksPassed=false is a mesh-quality verdict, not an error: '
  + 'refine (smaller cellSizeMm) or use wallGrading, or supply blockMeshDict — full dict text '
  + '(convertToMeters 1, patches must still be named inlet/outlet/walls) — for anything '
  + 'non-rectangular. checksPassed=null means the checkMesh output could not be parsed: read '
  + 'checkMeshLogPath yourself.'

/** Receipt shape of the `cfd_mesh` stage, pinned for the tool's output schema. */
export interface CfdMeshReceipt {
  caseDir: string
  blockMeshDictPath: string
  boundsM: { min: number[]; max: number[] } | null
  cells: number | null
  maxNonOrthogonalityDeg: number | null
  maxAspectRatio: number | null
  checksPassed: boolean | null
  checkMeshLogPath: string
  logTail: string
}

/** Build the `cae_cfd_mesh` tool bound to one deployment configuration. */
export function defineCaeCfdMeshTool(config: Config) {
  return defineTool({
    name: 'cae_cfd_mesh',
    description: DESCRIPTION,
    parameters: {
      lengthMm: { type: 'number', required: true, description: 'Duct length in mm (flow direction x).' },
      widthMm: { type: 'number', required: true, description: 'Cross-section width in mm (y).' },
      heightMm: { type: 'number', required: true, description: 'Cross-section height in mm (z).' },
      cellSizeMm: { type: 'number', required: true, description: 'Target cell edge in mm; per-direction counts are rounded.' },
      wallGrading: { type: 'number', description: 'Symmetric center-to-wall expansion ratio in y/z (1 = uniform). Default 1.' },
      blockMeshDict: { type: 'string', description: 'Full blockMeshDict text (escape hatch); overrides the parametric geometry.' },
      name: { type: 'string', description: 'Case directory name under <workdir>/cfd/. Default "duct".' },
    },
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        properties: {
          caseDir: { type: 'string', required: true },
          blockMeshDictPath: { type: 'string', required: true },
          boundsM: {
            oneOf: [{ type: 'object', additionalProperties: false, properties: {
              min: { type: 'array', items: { type: 'number' }, required: true },
              max: { type: 'array', items: { type: 'number' }, required: true },
            } }, { type: 'null' }], required: true,
          },
          cells: { oneOf: [{ type: 'integer' }, { type: 'null' }], required: true },
          maxNonOrthogonalityDeg: { oneOf: [{ type: 'number' }, { type: 'null' }], required: true },
          maxAspectRatio: { oneOf: [{ type: 'number' }, { type: 'null' }], required: true },
          checksPassed: { oneOf: [{ type: 'boolean' }, { type: 'null' }], required: true },
          checkMeshLogPath: { type: 'string', required: true },
          logTail: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: `blockMesh: ${value.cells ?? '?'} cells, max non-orthogonality `
          + `${value.maxNonOrthogonalityDeg ?? 'n/a'}°, max aspect ${value.maxAspectRatio ?? 'n/a'}, checks `
          + `${value.checksPassed === null ? 'unparsed — read checkMeshLogPath' : value.checksPassed ? 'OK' : 'FAILED (refine or escape via blockMeshDict)'}. `
          + `Case: ${value.caseDir}`,
      }],
    },
    async execute(args, exec) {
      const name = args.name ?? 'duct'
      if (name.includes('/') || name.includes('\\') || name === '.' || name === '..') {
        throw new Error(`case name '${name}' must be a plain directory name`)
      }
      await ensureDeps(config, exec.signal, 'cfd')
      const workdirAbs = resolve(config.workdir)
      await mkdir(join(workdirAbs, 'cfd'), { recursive: true })
      const argv = [
        '--workdir', workdirAbs,
        '--name', name,
        '--length-mm', String(args.lengthMm),
        '--width-mm', String(args.widthMm),
        '--height-mm', String(args.heightMm),
        '--cell-size-mm', String(args.cellSizeMm),
        '--wall-grading', String(args.wallGrading ?? 1),
      ]
      if (args.blockMeshDict) {
        const dictFile = join(workdirAbs, 'cfd', `${name}.blockMeshDict.txt`)
        await writeFile(dictFile, args.blockMeshDict, 'utf8')
        argv.push('--block-mesh-dict-file', dictFile)
      }
      if (config.openfoamBashrc) argv.push('--bashrc', config.openfoamBashrc)
      const { receipt } = await runStage(config, 'cfd_mesh', argv,
        { signal: exec.signal, logFile: `cfd.${name}.mesh.log` })
      return receipt as unknown as CfdMeshReceipt
    },
    presentCall: args => ({ card: 'terminal', title: `blockMesh ${args.name ?? 'duct'}`, description: 'CFD duct mesh' }),
  })
}
