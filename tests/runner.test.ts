import { describe, expect, it, beforeAll, afterAll } from 'vitest'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pythonDir, runStage } from '../src/runner.ts'
import type { Config } from '../src/config.ts'

const HAS_PYTHON = process.platform !== 'win32'
const py = HAS_PYTHON ? 'python3' : 'python'

describe.skipIf(!HAS_PYTHON)('runStage', () => {
  let work: string
  let config: Config
  beforeAll(async () => {
    work = await mkdtemp(join(tmpdir(), 'dsh-cae-'))
    config = { python: py, workdir: work, stageTimeoutMs: 10_000 }
  })
  afterAll(async () => { await rm(work, { recursive: true, force: true }) })

  it('pythonDir() points at the shipped python package directory', async () => {
    const { stat } = await import('node:fs/promises')
    expect((await stat(join(pythonDir(), 'dsh_cae')).then(() => true, () => false))).toBe(true)
  })

  it('returns the receipt and writes the full log file', async () => {
    const res = await runStage(config, 'fixtures.fake_stage',
      ['--mode', 'ok'], { logFile: 'fake.log' })
    expect(res.receipt).toEqual({ ok: true, value: 42 })
    const log = await readFile(join(work, 'fake.log'), 'utf8')
    expect(log).toContain('noise line before receipt')
  })

  it('throws an infrastructure error embedding the tail on stage exit 1', async () => {
    await expect(runStage(config, 'fixtures.fake_stage',
      ['--mode', 'fail'], { logFile: 'fake-fail.log' }))
      .rejects.toThrow(/boom: kernel exploded/)
  })

  it('kills the stage process group on timeout and reports it', async () => {
    await expect(runStage({ ...config, stageTimeoutMs: 500 }, 'fixtures.fake_stage',
      ['--mode', 'sleep'], { logFile: 'fake-sleep.log' }))
      .rejects.toThrow(/timed out after 500ms/)
  })

  it('rejects when the receipt marker is missing', async () => {
    await expect(runStage(config, 'fixtures.fake_stage',
      ['--mode', 'no-receipt'], { logFile: 'fake-none.log' }))
      .rejects.toThrow(/no receipt/)
  })
})
