import { describe, expect, it } from 'vitest'
import { runStage } from '../src/runner.ts'
import type { Config } from '../src/config.ts'

const HAS_PYTHON = process.platform !== 'win32'

describe.skipIf(!HAS_PYTHON)('deps stage', () => {
  it('reports a receipt with ok:boolean and missing list', async () => {
    const config: Config = { python: 'python3', workdir: './cae-tmp', stageTimeoutMs: 60_000 }
    const { receipt } = await runStage(config, 'deps', [], { logFile: 'deps-check.log' })
    expect(typeof receipt.ok).toBe('boolean')
    if (receipt.ok === false) {
      expect(Array.isArray(receipt.missing)).toBe(true)
      expect((receipt.missing as string[]).length).toBeGreaterThan(0)
    }
  })

  it('routes the cfd group through the stage and reports its group', async () => {
    const config: Config = { python: 'python3', workdir: './cae-tmp', stageTimeoutMs: 60_000 }
    const { receipt } = await runStage(config, 'deps', ['--group', 'cfd'], { logFile: 'deps-cfd.log' })
    expect(receipt.group).toBe('cfd')
    expect(typeof receipt.ok).toBe('boolean')
  })
})
