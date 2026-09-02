import { describe, expect, it } from 'vitest'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import { apply } from '../src/index.ts'
import { Config } from '../src/config.ts'
import { defineCaePostTool } from '../src/tools/post.ts'

const registered: unknown[] = []
const ctx = { tools: { register: (t: unknown) => registered.push(t) } } as never

describe('plugin wiring', () => {
  it('apply registers exactly the seven CAE tools in name order', () => {
    apply(ctx, { python: 'python3', workdir: './cae', stageTimeoutMs: 1000 })
    const names = registered.map(t => (t as { name: string }).name).sort()
    expect(names).toEqual([
      'cae_cad_build', 'cae_cfd_mesh', 'cae_cfd_steady', 'cae_mesh_generate',
      'cae_post_process', 'cae_solve_static', 'cae_step_import',
    ])
  })
})

describe('cae_post_process input validation', () => {
  it('rejects when both vtu and frd are given, without starting Python', async () => {
    const post = defineCaePostTool({ python: 'python3', workdir: './cae-stub', stageTimeoutMs: 1000 })
    await expect(post.execute(
      { vtu: 'case.vtu', frd: 'case.frd' },
      { signal: new AbortController().signal } as ToolRunContext,
    )).rejects.toThrow('provide either vtu or frd, not both')
  })
})

describe('cae_post_process CFD fields', () => {
  it('rejects probes using the old pointMm key', async () => {
    const post = defineCaePostTool({ python: 'python3', workdir: './cae-stub', stageTimeoutMs: 1000 })
    await expect(post.execute(
      { vtu: 'duct.vtk', probes: [{ field: 'velocity', pointMm: [1, 2, 3] } as never] },
      { signal: new AbortController().signal } as ToolRunContext,
    )).rejects.toThrow()
  })
})
