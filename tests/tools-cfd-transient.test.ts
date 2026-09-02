// tests/tools-cfd-transient.test.ts
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import { defineCaeCfdTransientTool } from '../src/tools/cfd-transient.ts'

vi.mock('../src/runner.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/runner.js')>()
  return { ...actual, ensureDeps: vi.fn(), runStage: vi.fn() }
})

const config = { python: 'python3', workdir: './cae-stub', stageTimeoutMs: 1000 } as const
const exec = () => ({ signal: new AbortController().signal }) as ToolRunContext
const runnerMod = async () => import('../src/runner.js')

const workdirs: string[] = []
const workdir = async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-cae-transient-'))
  workdirs.push(dir)
  return dir
}
afterAll(async () => {
  await Promise.all(workdirs.map(d => rm(d, { recursive: true, force: true })))
})

beforeEach(async () => {
  const runner = await runnerMod()
  vi.mocked(runner.runStage).mockReset()
  vi.mocked(runner.runStage).mockResolvedValue({ receipt: {}, logPath: '/tmp/stub.log' })
  vi.mocked(runner.ensureDeps).mockResolvedValue(undefined)
})

const base = { caseDir: '', inletVelocityMS: [0.02, 0, 0], kinematicViscosityM2S: 1e-6 } as const

describe('cae_cfd_transient validation', () => {
  it('rejects inletVelocityMS that is not [u, v, w]', async () => {
    const tool = defineCaeCfdTransientTool(config)
    await expect(tool.execute({ ...base, caseDir: './c', inletVelocityMS: [1], endTimeS: 1 }, exec()))
      .rejects.toThrow('inletVelocityMS must be [u, v, w]')
  })

  it('rejects non-positive endTimeS', async () => {
    const tool = defineCaeCfdTransientTool(config)
    await expect(tool.execute({ ...base, caseDir: './c', endTimeS: 0 }, exec()))
      .rejects.toThrow('endTimeS must be a positive number')
  })

  it('rejects writeIntervalS greater than endTimeS', async () => {
    const tool = defineCaeCfdTransientTool(config)
    await expect(tool.execute({ ...base, caseDir: './c', endTimeS: 0.1, writeIntervalS: 0.2 }, exec()))
      .rejects.toThrow('writeIntervalS must be in (0, endTimeS]')
  })

  it('rejects maxCourant <= 0 when deltaTS is not fixing the step', async () => {
    const tool = defineCaeCfdTransientTool(config)
    await expect(tool.execute({ ...base, caseDir: './c', endTimeS: 1, maxCourant: 0 }, exec()))
      .rejects.toThrow('maxCourant must be positive when deltaTS is not set')
  })

  it('rejects a case stem with path separators', async () => {
    const tool = defineCaeCfdTransientTool(config)
    await expect(tool.execute({ ...base, caseDir: './c', endTimeS: 1, case: 'a/b' }, exec()))
      .rejects.toThrow('path separators')
  })

  it('rejects a non-existent caseDir before spawning a stage', async () => {
    const tool = defineCaeCfdTransientTool(config)
    await expect(tool.execute({ ...base, caseDir: './no-such-case', endTimeS: 1 }, exec()))
      .rejects.toThrow('does not exist')
  })
})

describe('cae_cfd_transient argv + bashrc', () => {
  it('builds the transient argv', async () => {
    const work = await workdir()
    const caseDir = join(work, 'cfd', 'duct')
    await mkdir(caseDir, { recursive: true })
    const tool = defineCaeCfdTransientTool({ ...config, workdir: work })
    await tool.execute({
      caseDir, inletVelocityMS: [0.02, 0, 0], kinematicViscosityM2S: 1e-6,
      endTimeS: 2, writeIntervalS: 0.1, densityKgM3: 1000,
    }, exec())
    const runner = await runnerMod()
    const call = vi.mocked(runner.runStage).mock.calls.find(([, stage]) => stage === 'cfd_transient')
    expect(call).toBeDefined()
    const argv = call![2]
    expect(argv[argv.indexOf('--end-time-s') + 1]).toBe('2')
    expect(argv[argv.indexOf('--write-interval-s') + 1]).toBe('0.1')
    expect(argv[argv.indexOf('--max-co') + 1]).toBe('0.5')
    expect(argv).not.toContain('--delta-t')
  })

  it('drops --bashrc under the docker runtime', async () => {
    const work = await workdir()
    const caseDir = join(work, 'cfd', 'duct')
    await mkdir(caseDir, { recursive: true })
    const tool = defineCaeCfdTransientTool({
      ...config, workdir: work,
      python: 'docker://ghcr.io/daiyuhangsustc/dsh-cae:latest',
      openfoamBashrc: '/opt/openfoam11/etc/bashrc',
    })
    await tool.execute({ ...base, caseDir, endTimeS: 1 }, exec())
    const runner = await runnerMod()
    const argv = vi.mocked(runner.runStage).mock.calls
      .find(([, stage]) => stage === 'cfd_transient')![2]
    expect(argv).not.toContain('--bashrc')
  })
})
