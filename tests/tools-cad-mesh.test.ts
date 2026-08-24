import { describe, expect, it } from 'vitest'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import { defineCaeCadTool } from '../src/tools/cad.ts'
import { defineCaeMeshTool } from '../src/tools/mesh.ts'
import { runStage } from '../src/runner.ts'
import type { Config } from '../src/config.ts'

const config: Config = {
  python: 'python3',
  workdir: './cae-stub',
  stageTimeoutMs: 60_000,
}

// Real-kernel gate: run the deps stage; skip the whole suite without the stack.
const kernelsPresent = await (async () => {
  try {
    const { receipt } = await runStage(
      { ...config, workdir: './cae-deps' }, 'deps', [], { logFile: 'deps.log' },
    )
    return receipt.ok === true
  } catch {
    return false
  }
})()

describe.skipIf(!kernelsPresent)('cae_cad_build / cae_mesh_generate (real kernels)', () => {
  it('builds a cantilever and meshes it, threading paths', async () => {
    const cad = defineCaeCadTool(config)
    const built = await cad.execute({
      script: 'from build123d import Box\npart = Box(100, 20, 5)\n',
      name: 'it-beam',
    }, fakeExec()) as { stepPath: string; volumeMm3: number }
    expect(built.volumeMm3).toBeCloseTo(10000, 6)

    const mesh = defineCaeMeshTool(config)
    const meshed = await mesh.execute(
      { step: built.stepPath, elementSizeMm: 4 }, fakeExec(),
    ) as { groupNames: string[] }
    expect(meshed.groupNames).toContain('solid')
  })
})

function fakeExec(): ToolRunContext {
  return { signal: new AbortController().signal } as ToolRunContext
}
