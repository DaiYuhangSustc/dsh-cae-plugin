import { defineTool } from '@deepseek-ai/dsh-tools'
import { ensureDeps, runStage } from '../runner.js'
import type { Config } from '../config.js'

const DESCRIPTION =
  'Mesh a STEP solid with Gmsh second-order tetrahedra. Units are mm. Pass the STEP path '
  + 'returned by cae_cad_build; named face groups are rebuilt automatically from the '
  + 'sidecar next to the STEP. elementSizeMm is the target edge length (smaller = finer, '
  + 'more accurate, slower solve). Returns node/element counts, group names, and the '
  + 'minimum scaled Jacobian (quality; > 0.01 is healthy).'

/** Receipt shape of the `mesh` stage, pinned for the tool's output schema. */
export interface MeshReceipt {
  mshPath: string
  nodeCount: number
  elementCount: number
  groupNames: string[]
  quality: { minJacobian: number | null }
}

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
            properties: {
              minJacobian: {
                oneOf: [{ type: 'number' }, { type: 'null' }],
                required: true,
                description: 'Minimum scaled Jacobian; null when no element admits the measure.',
              },
            },
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
      const facesJson = `${stem}.faces.json`
      const argv = [
        '--step', args.step,
        '--faces-json', facesJson,
        '--msh', msh,
        '--element-size', String(args.elementSizeMm ?? 2.0),
        '--element-type', args.elementType ?? 'tet10',
      ]
      if (args.minSizeMm) argv.push('--min-size', String(args.minSizeMm))
      if (args.maxSizeMm) argv.push('--max-size', String(args.maxSizeMm))
      const { receipt } = await runStage(config, 'mesh', argv,
        { signal: exec.signal, logFile: `${stem.split('/').pop()}.mesh.log` })
      return receipt as unknown as MeshReceipt
    },
    presentCall: args => ({ card: 'generic', title: 'Generate mesh', kind: 'other', rawInput: { step: args.step } }),
  })
}
