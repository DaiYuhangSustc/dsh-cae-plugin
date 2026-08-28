import { mkdtemp, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import { defineCaeCfdMeshTool } from '../src/tools/cfd-mesh.ts'
import { defineCaeCfdSteadyTool } from '../src/tools/cfd-steady.ts'

vi.mock('../src/runner.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/runner.js')>()
  return { ...actual, ensureDeps: vi.fn(), runStage: vi.fn() }
})

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

// --bashrc forwarding vs runtime: a host OpenFOAM bashrc path cannot exist
// inside the container, so the docker runtime must drop it (the image's own
// OpenFOAM is auto-detected). runStage is mocked at the module boundary —
// what matters here is the argv the tools build, not the subprocess.
describe('openfoamBashrc forwarding', () => {
  const hostBashrc = '/opt/openfoam11/etc/bashrc'
  const dockerConfig = { python: 'docker://ghcr.io/daiyuhangsustc/dsh-cae:latest', openfoamBashrc: hostBashrc }

  // The mocked module is stable across the file; resolve it fresh each time
  // so mockReset ordering reads clearly.
  const runnerMod = async () => import('../src/runner.js')

  beforeEach(async () => {
    const runner = await runnerMod()
    vi.mocked(runner.runStage).mockReset()
    vi.mocked(runner.runStage).mockResolvedValue({ receipt: { ok: true }, logPath: '/tmp/stub.log' })
    vi.mocked(runner.ensureDeps).mockResolvedValue(undefined)
  })

  const meshArgs = { lengthMm: 1000, widthMm: 20, heightMm: 20, cellSizeMm: 2.5 } as const
  const steadyArgs = { inletVelocityMS: [0.02, 0, 0], kinematicViscosityM2S: 1e-6 } as const

  it('forwards --bashrc to cfd_mesh under the local runtime', async () => {
    const tool = defineCaeCfdMeshTool({ ...config, openfoamBashrc: hostBashrc })
    await tool.execute({ ...meshArgs }, exec())
    const runner = await runnerMod()
    const calls = vi.mocked(runner.runStage).mock.calls
    const meshCall = calls.find(([, stage]) => stage === 'cfd_mesh')
    expect(meshCall).toBeDefined()
    expect(meshCall![2]).toContain('--bashrc')
    expect(meshCall![2][meshCall![2].indexOf('--bashrc') + 1]).toBe(hostBashrc)
  })

  it('drops --bashrc from cfd_mesh under the docker runtime', async () => {
    const tool = defineCaeCfdMeshTool({ ...config, ...dockerConfig })
    await tool.execute({ ...meshArgs }, exec())
    const runner = await runnerMod()
    const calls = vi.mocked(runner.runStage).mock.calls
    const meshCall = calls.find(([, stage]) => stage === 'cfd_mesh')
    expect(meshCall).toBeDefined()
    expect(meshCall![2]).not.toContain('--bashrc')
  })

  it('drops --bashrc from cfd_steady under the docker runtime', async () => {
    const work = await mkdtemp(join(tmpdir(), 'dsh-cae-bashrc-'))
    const caseDir = join(work, 'cae', 'cfd', 'duct')
    await mkdir(caseDir, { recursive: true })
    const tool = defineCaeCfdSteadyTool({ ...config, ...dockerConfig, workdir: work })
    await tool.execute({ ...steadyArgs, caseDir }, exec())
    const runner = await runnerMod()
    const calls = vi.mocked(runner.runStage).mock.calls
    const steadyCall = calls.find(([, stage]) => stage === 'cfd_steady')
    expect(steadyCall).toBeDefined()
    expect(steadyCall![2]).not.toContain('--bashrc')
  })
})
