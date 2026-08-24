import { writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { ensureDeps, runStage } from '../runner.js'
import type { Config } from '../config.js'

const DESCRIPTION =
  'Build a CAD solid by running a build123d Python script. Units are mm. '
  + 'The script MUST assign a solid to `part` (e.g. `part = Box(100, 20, 5)`). '
  + 'To prepare boundary conditions, also assign NAMED_FACES = {"<groupName>": <Face or list of Faces>} '
  + 'for faces you will later fix or load (e.g. the clamp face and the load face); '
  + 'group names survive into meshing and solving. Returns the STEP path, volume, '
  + 'bounding box, and the named faces with areas and centroids.'

/** Receipt shape of the `cad` stage, pinned for the tool's output schema. */
export interface CadReceipt {
  stepPath: string
  volumeMm3: number
  bboxMm: { min: number[]; max: number[] }
  namedFaces: { name: string; areaMm2: number; centroidMm: number[] }[]
}

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
      const dir = resolve(config.workdir)
      const scriptFile = join(dir, `${stem}.cad.py`)
      const step = join(dir, `${stem}.step`)
      const facesJson = join(dir, `${stem}.faces.json`)
      await writeFile(scriptFile, args.script, 'utf8')
      const { receipt } = await runStage(config, 'cad',
        ['--script-file', scriptFile, '--step', step, '--faces-json', facesJson],
        { signal: exec.signal, logFile: `${stem}.cad.log` })
      return receipt as unknown as CadReceipt
    },
    presentCall: args => ({ card: 'generic', title: 'Build CAD part', kind: 'other', rawInput: { name: args.name ?? 'part' } }),
  })
}
