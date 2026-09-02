// tests/verify-mesh.test.ts
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import { defineCaeVerifyMeshTool } from '../src/tools/verify-mesh.ts'

vi.mock('../src/runner.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/runner.js')>()
  return { ...actual, ensureDeps: vi.fn(), runStage: vi.fn() }
})

const config = { python: 'python3', workdir: './cae-stub', stageTimeoutMs: 1000 } as const
const exec = () => ({ signal: new AbortController().signal }) as ToolRunContext
const runnerMod = async () => import('../src/runner.js')

const workdirs: string[] = []
const workdir = async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-cae-verify-'))
  workdirs.push(dir)
  return dir
}
afterAll(async () => {
  await Promise.all(workdirs.map(d => rm(d, { recursive: true, force: true })))
})

// 制造解计数（精确比 1.5）：v = 100 + 1/N → p = 3，GCI≈0
const COUNTS: Record<string, number> = { '8': 1000, '5': 3375, '3': 11390.625 }
const valueFor = (count: number) => 100 + 1 / count

// post 的 metric 值由 mesh 顺序驱动：mesh/cfd_mesh 见到 size 时 push，post 弹出
// 队首 —— verify-mesh 按粗→细逐档执行，post 第 k 次 = 第 k 档。
const sizeQueue: number[] = []

const structuralArgs = {
  chain: 'structural' as const,
  step: '/tmp/beam.step',
  facesJson: '/tmp/beam.faces.json',
  material: { youngMPa: 210000, poisson: 0.3 },
  fixedGroups: ['fixed'],
  loads: [{ group: 'load', forceN: [0, 0, -1000] }],
  elementSizesMm: [3, 5, 8],   // 乱序输入
}

beforeEach(async () => {
  const runner = await runnerMod()
  sizeQueue.length = 0
  vi.mocked(runner.runStage).mockReset()
  vi.mocked(runner.runStage).mockImplementation(async (_cfg, stage, argv) => {
    const flag = (name: string) => {
      const i = argv.indexOf(name)
      return i >= 0 ? argv[i + 1] : undefined
    }
    if (stage === 'mesh') {
      const size = flag('--element-size')!
      sizeQueue.push(Number(size))
      return { receipt: { nodeCount: COUNTS[size] ?? 1000 }, logPath: '' }
    }
    if (stage === 'solve') {
      return { receipt: { vtuPath: '/tmp/x.vtu', frdPath: '/tmp/x.frd' }, logPath: '' }
    }
    if (stage === 'post') {
      const size = String(sizeQueue.shift())
      return { receipt: { values: [{ value: valueFor(COUNTS[size] ?? 8000) }] }, logPath: '' }
    }
    if (stage === 'cfd_mesh') {
      const size = flag('--cell-size-mm')!
      sizeQueue.push(Number(size))
      return { receipt: { cells: COUNTS[size] ?? 1000, caseDir: '/tmp/cfd/verify-l0' }, logPath: '' }
    }
    if (stage === 'cfd_steady') {
      return { receipt: { converged: true, vtkPath: '/tmp/y.vtk' }, logPath: '' }
    }
    throw new Error(`unexpected stage ${stage}`)
  })
  vi.mocked(runner.ensureDeps).mockResolvedValue(undefined)
})

describe('cae_verify_mesh validation', () => {
  it('rejects fewer than 3 sizes', async () => {
    const tool = defineCaeVerifyMeshTool({ ...config, workdir: await workdir() })
    await expect(tool.execute({ ...structuralArgs, elementSizesMm: [8, 5] }, exec()))
      .rejects.toThrow('at least 3')
  })

  it('rejects non-monotonic sizes', async () => {
    const tool = defineCaeVerifyMeshTool({ ...config, workdir: await workdir() })
    await expect(tool.execute({ ...structuralArgs, elementSizesMm: [8, 5, 8] }, exec()))
      .rejects.toThrow('strictly monotonic')
  })

  it('requires structural loads and fixedGroups', async () => {
    const tool = defineCaeVerifyMeshTool({ ...config, workdir: await workdir() })
    await expect(tool.execute({ ...structuralArgs, loads: [] }, exec()))
      .rejects.toThrow('at least one load')
  })
})

describe('cae_verify_mesh structural chain', () => {
  it('meshes, solves, and posts per level in coarse-to-fine order', async () => {
    const work = await workdir()
    const step = join(work, 'beam.step')
    const faces = join(work, 'beam.faces.json')
    await writeFile(step, 'x')
    await writeFile(faces, '{}')
    const tool = defineCaeVerifyMeshTool({ ...config, workdir: work })
    const receipt = await tool.execute({ ...structuralArgs, step, facesJson: faces }, exec())
    const runner = await runnerMod()
    const stages = vi.mocked(runner.runStage).mock.calls.map(([, s]) => s)
    expect(stages).toEqual(['mesh', 'solve', 'post', 'mesh', 'solve', 'post', 'mesh', 'solve', 'post'])
    const sizes = vi.mocked(runner.runStage).mock.calls
      .filter(([, s]) => s === 'mesh')
      .map(([,, argv]) => argv[argv.indexOf('--element-size') + 1])
    expect(sizes).toEqual(['8', '5', '3'])  // 粗→细
    expect(receipt.levels.map((l: any) => l.sizeMm)).toEqual([8, 5, 3])
    expect(receipt.levels.map((l: any) => l.count)).toEqual([1000, 3375, 11390.625])
    expect(receipt.observedOrder).toBeCloseTo(3, 3)
    expect(receipt.meshIndependent).toBe(true)
    expect(receipt.recommendation).toContain('8')
  })

  it('labels the failing level when a stage dies mid-study', async () => {
    const runner = await runnerMod()
    vi.mocked(runner.runStage).mockImplementation(async (_cfg, stage) => {
      if (stage === 'post') return Promise.reject(new Error('boom'))
      return { receipt: { nodeCount: 1, vtuPath: '/x.vtu', frdPath: '/x.frd' }, logPath: '' }
    })
    const tool = defineCaeVerifyMeshTool({ ...config, workdir: await workdir() })
    await expect(tool.execute({ ...structuralArgs }, exec()))
      .rejects.toThrow('level 1')
  })
})

describe('cae_verify_mesh cfd chain', () => {
  const cfdArgs = {
    chain: 'cfd' as const,
    lengthMm: 1000, widthMm: 20, heightMm: 20,
    inletVelocityMS: [0.02, 0, 0], kinematicViscosityM2S: 1e-6,
    cellSizesMm: [8, 5, 3], densityKgM3: 1000,
  }

  it('fails the study when a level does not converge', async () => {
    const runner = await runnerMod()
    const orig = vi.mocked(runner.runStage).getMockImplementation()
    vi.mocked(runner.runStage).mockImplementation(async (cfg, stage, argv) => {
      const out = await orig!(cfg, stage, argv)
      if (stage === 'cfd_steady') out.receipt = { ...out.receipt, converged: false }
      return out
    })
    const tool = defineCaeVerifyMeshTool({ ...config, workdir: await workdir() })
    await expect(tool.execute({ ...cfdArgs }, exec()))
      .rejects.toThrow('did not converge')
  })

  it('computes pressure drop from inlet/outlet probes', async () => {
    const work = await workdir()
    const runner = await runnerMod()
    const orig = vi.mocked(runner.runStage).getMockImplementation()
    let probeCalls = 0
    vi.mocked(runner.runStage).mockImplementation(async (cfg, stage, argv) => {
      if (stage === 'post') {
        const probes = argv.filter(a => a.startsWith('p,'))
        expect(probes).toHaveLength(2)
        // 逐档检查：第 k 次探针对应第 k 档（粗→细），eps = cell/2 换米。
        const eps = [0.004, 0.0025, 0.0015][probeCalls]!
        probeCalls += 1
        expect(probes[0]).toMatch(new RegExp(`^p,${String(eps).replace('.', '\\.')},0\\.01,0\\.01$`))
        return { receipt: { values: [{ value: 12.5 }, { value: 2.5 }] }, logPath: '' }
      }
      return orig!(cfg, stage, argv)
    })
    const tool = defineCaeVerifyMeshTool({ ...config, workdir: work })
    await tool.execute({ ...cfdArgs, metric: 'pressureDropPa' }, exec())
  })
})
