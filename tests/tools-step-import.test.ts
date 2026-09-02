// tests/tools-step-import.test.ts
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import { defineCaeStepImportTool } from '../src/tools/step-import.ts'

vi.mock('../src/runner.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/runner.js')>()
  return { ...actual, ensureDeps: vi.fn(), runStage: vi.fn() }
})

const config = { python: 'python3', workdir: './cae-stub', stageTimeoutMs: 1000 } as const
const exec = () => ({ signal: new AbortController().signal }) as ToolRunContext

const runnerMod = async () => import('../src/runner.js')

const workdirs: string[] = []
const workdir = async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-cae-stepimport-'))
  workdirs.push(dir)
  return dir
}
afterAll(async () => {
  await Promise.all(workdirs.map(d => rm(d, { recursive: true, force: true })))
})

beforeEach(async () => {
  const runner = await runnerMod()
  vi.mocked(runner.runStage).mockReset()
  vi.mocked(runner.runStage).mockResolvedValue({ receipt: { stepOut: '/x.step' }, logPath: '/tmp/stub.log' })
  vi.mocked(runner.ensureDeps).mockResolvedValue(undefined)
})

describe('cae_step_import argv construction', () => {
  it('resolves the step path and omits repair by default', async () => {
    const tool = defineCaeStepImportTool({ ...config, workdir: await workdir() })
    await tool.execute({ step: './bracket.step' }, exec())
    const runner = await runnerMod()
    const call = vi.mocked(runner.runStage).mock.calls.find(([, stage]) => stage === 'step_import')
    expect(call).toBeDefined()
    const argv = call![2]
    expect(argv[argv.indexOf('--step') + 1]).toBe(resolve('./bracket.step'))
    expect(argv).not.toContain('--repair')
    expect(argv).toContain('--faces-json')
  })

  it('forwards repair and nameFaces as stage flags', async () => {
    const tool = defineCaeStepImportTool({ ...config, workdir: await workdir() })
    const facesJson = '/tmp/bracket.faces.json'
    await tool.execute({
      step: '/tmp/bracket.step', repair: true, facesJson,
      nameFaces: [{ faceId: 2, name: 'fixed' }, { faceId: 3, name: 'load' }],
    }, exec())
    const runner = await runnerMod()
    const argv = vi.mocked(runner.runStage).mock.calls[0]![2]
    expect(argv).toContain('--repair')
    const nf = argv[argv.indexOf('--name-faces') + 1]
    expect(JSON.parse(nf)).toEqual([{ faceId: 2, name: 'fixed' }, { faceId: 3, name: 'load' }])
    expect(argv[argv.indexOf('--faces-json') + 1]).toBe(facesJson)
  })
})
