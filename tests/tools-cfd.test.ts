import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import { defineCaeCfdMeshTool } from '../src/tools/cfd-mesh.ts'
import { defineCaeCfdSteadyTool } from '../src/tools/cfd-steady.ts'

const config = { python: 'python3', workdir: './cae-stub', stageTimeoutMs: 1000 } as const
const exec = () => ({ signal: new AbortController().signal }) as ToolRunContext

describe('cae_cfd_mesh validation', () => {
  it('rejects a case name with path separators before starting Python', async () => {
    const tool = defineCaeCfdMeshTool(config)
    await expect(tool.execute({
      lengthMm: 1000, widthMm: 20, heightMm: 20, cellSizeMm: 2.5, name: '../escape',
    }, exec())).rejects.toThrow('must be a plain directory name')
  })
})

describe('cae_cfd_steady validation', () => {
  it('rejects inletVelocityMS that is not [u, v, w]', async () => {
    const tool = defineCaeCfdSteadyTool(config)
    await expect(tool.execute({
      caseDir: './cae/cfd/duct', inletVelocityMS: [0.02], kinematicViscosityM2S: 1e-6,
    }, exec())).rejects.toThrow('inletVelocityMS must be [u, v, w]')
  })

  it('rejects non-positive iterations', async () => {
    const tool = defineCaeCfdSteadyTool(config)
    await expect(tool.execute({
      caseDir: './cae/cfd/duct', inletVelocityMS: [0.02, 0, 0],
      kinematicViscosityM2S: 1e-6, iterations: 0,
    }, exec())).rejects.toThrow('iterations must be a positive integer')
  })

  it('rejects a case stem with path separators', async () => {
    const tool = defineCaeCfdSteadyTool(config)
    await expect(tool.execute({
      caseDir: './cae/cfd/duct', inletVelocityMS: [0.02, 0, 0],
      kinematicViscosityM2S: 1e-6, case: 'a/b',
    }, exec())).rejects.toThrow('path separators')
  })

  it('rejects a non-existent caseDir before writing overrides or spawning a stage', async () => {
    const missing = './cae/cfd/no-such-case'
    const tool = defineCaeCfdSteadyTool(config)
    await expect(tool.execute({
      caseDir: missing, inletVelocityMS: [0.02, 0, 0],
      kinematicViscosityM2S: 1e-6,
      overrides: [{ file: 'system/controlDict', entry: 'endTime', dict: 'endTime 5;' }],
    }, exec())).rejects.toThrow(`caseDir '${resolve(missing)}' does not exist`)
  })
})
