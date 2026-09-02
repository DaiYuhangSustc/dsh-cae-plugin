// src/tools/step-import.ts
import { resolve } from 'node:path'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { ensureDeps, runStage } from '../runner.js'
import type { Config } from '../config.js'

const DESCRIPTION =
  'Import an external STEP file (mm): validate the geometry (invalid solids, free edges, '
  + 'sliver faces, short edges, mergeable split faces) and optionally heal it (OCCT ShapeFix '
  + '+ same-domain merge; healed geometry is written to a new *_clean.step). Recommended flow: '
  + 'call WITHOUT nameFaces first and read the faces table (id, areaMm2, centroidMm, normal), '
  + 'decide which faces carry boundary conditions, then call again with nameFaces '
  + '[{faceId, name}] — with the SAME repair setting as the first call — to write the '
  + 'faces.json sidecar that cae_mesh_generate rebuilds into named groups for '
  + 'cae_solve_static. clean=false issues are reports, not errors; heal them by re-calling '
  + 'with repair=true. Only unreadable files, solids-free geometry, or bad faceIds fail.'

/** Receipt shape of the `step_import` stage, pinned for the tool's output schema. */
export interface StepImportReceipt {
  stepPath: string
  stepOut: string
  repaired: boolean
  repairedDelta: { facesBefore: number; facesAfter: number; mergeableFacesRemaining: number } | null
  checks: {
    solidCount: number
    faceCount: number
    invalidSolids: number
    freeEdges: boolean
    sliverFaces: { id: number; areaMm2: number }[]
    shortEdges: { count: number; minLengthMm: number | null; thresholdMm: number }
    mergeableFaces: number
    clean: boolean
  }
  faces: { id: number; areaMm2: number; centroidMm: number[]; normal: number[] }[]
  namedGroups: { name: string; faceIds: number[] }[]
  facesJsonPath: string | null
}

/** Build the `cae_step_import` tool bound to one deployment configuration. */
export function defineCaeStepImportTool(config: Config) {
  return defineTool({
    name: 'cae_step_import',
    description: DESCRIPTION,
    parameters: {
      step: { type: 'string', required: true, description: 'Path to the .step file to import (mm).' },
      repair: { type: 'boolean', description: 'Heal the geometry (ShapeFix + merge split faces) into a new *_clean.step. Default false.' },
      nameFaces: {
        type: 'array',
        items: {
          type: 'object', additionalProperties: false,
          properties: {
            faceId: { type: 'integer', required: true },
            name: { type: 'string', required: true, description: 'Alphanumeric/underscore group name, e.g. "fixed".' },
          },
        },
        description: 'Face names assigned by faceId from the receipt table; writes the faces.json sidecar.',
      },
      facesJson: { type: 'string', description: 'Sidecar path for nameFaces; pass it as facesJson to cae_mesh_generate. Default <step stem>.faces.json.' },
    },
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        properties: {
          stepPath: { type: 'string', required: true },
          stepOut: { type: 'string', required: true },
          repaired: { type: 'boolean', required: true },
          repairedDelta: {
            oneOf: [{
              type: 'object', additionalProperties: false,
              properties: {
                facesBefore: { type: 'integer', required: true },
                facesAfter: { type: 'integer', required: true },
                mergeableFacesRemaining: { type: 'integer', required: true },
              },
            }, { type: 'null' }], required: true,
          },
          checks: {
            type: 'object', additionalProperties: false, required: true,
            properties: {
              solidCount: { type: 'integer', required: true },
              faceCount: { type: 'integer', required: true },
              invalidSolids: { type: 'integer', required: true },
              freeEdges: { type: 'boolean', required: true },
              sliverFaces: {
                type: 'array', required: true,
                items: { type: 'object', additionalProperties: false, properties: {
                  id: { type: 'integer', required: true }, areaMm2: { type: 'number', required: true },
                } },
              },
              shortEdges: {
                type: 'object', additionalProperties: false, required: true,
                properties: {
                  count: { type: 'integer', required: true },
                  minLengthMm: { oneOf: [{ type: 'number' }, { type: 'null' }], required: true },
                  thresholdMm: { type: 'number', required: true },
                },
              },
              mergeableFaces: { type: 'integer', required: true },
              clean: { type: 'boolean', required: true },
            },
          },
          faces: {
            type: 'array', required: true,
            items: { type: 'object', additionalProperties: false, properties: {
              id: { type: 'integer', required: true },
              areaMm2: { type: 'number', required: true },
              centroidMm: { type: 'array', items: { type: 'number' }, required: true },
              normal: { type: 'array', items: { type: 'number' }, required: true },
            } },
          },
          namedGroups: {
            type: 'array', required: true,
            items: { type: 'object', additionalProperties: false, properties: {
              name: { type: 'string', required: true },
              faceIds: { type: 'array', items: { type: 'integer' }, required: true },
            } },
          },
          facesJsonPath: { oneOf: [{ type: 'string' }, { type: 'null' }], required: true },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: `STEP import ${value.repaired ? '(repaired) ' : ''}${value.checks.clean ? 'clean' : 'dirty'}: `
          + `${value.checks.solidCount} solid(s), ${value.checks.faceCount} faces`
          + (value.checks.mergeableFaces ? `, ${value.checks.mergeableFaces} mergeable split faces` : '')
          + (value.checks.sliverFaces.length ? `, ${value.checks.sliverFaces.length} sliver faces` : '')
          + (value.checks.shortEdges.count ? `, ${value.checks.shortEdges.count} short edges` : '')
          + `. Geometry: ${value.stepOut}`,
      }],
    },
    async execute(args, exec) {
      const stepAbs = resolve(args.step)
      const facesJson = args.facesJson ?? stepAbs.replace(/\.step$/i, '') + '.faces.json'
      await ensureDeps(config, exec.signal, 'structural')
      const argv = ['--step', stepAbs]
      if (args.repair) argv.push('--repair')
      if (args.nameFaces?.length) {
        argv.push('--name-faces', JSON.stringify(args.nameFaces.map(f => ({ faceId: f.faceId, name: f.name }))))
      }
      argv.push('--faces-json', facesJson)
      const { receipt } = await runStage(config, 'step_import', argv,
        { signal: exec.signal, logFile: 'step_import.log' })
      return receipt as unknown as StepImportReceipt
    },
    presentCall: args => ({ card: 'terminal', title: `STEP import${args.repair ? ' + repair' : ''}`, description: 'External geometry check' }),
  })
}
