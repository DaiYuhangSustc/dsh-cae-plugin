// tests/interpreter.test.ts — interpreter discovery, spawn env, deps diagnostics.
import { describe, expect, it } from 'vitest'
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  defaultEnvCandidates,
  dockerArgv,
  dockerSpawnEnv,
  dockerPreflight,
  depsFailureMessage,
  parseRuntime,
  pythonDir,
  resolvePython,
  stageEnv,
} from '../src/interpreter.ts'

describe('resolvePython', () => {
  it('returns any configured value untouched unless it is "auto"', () => {
    expect(resolvePython('/opt/special/bin/python', [])).toBe('/opt/special/bin/python')
    expect(resolvePython('python3', [])).toBe('python3')
  })

  it('probes dsh-cae env candidates in order and picks the first executable bin/python', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-cae-py-'))
    try {
      const dead = join(root, 'dead-env') // exists but not executable -> skipped
      const live = join(root, 'live-env')
      await mkdir(join(dead, 'bin'), { recursive: true })
      await writeFile(join(dead, 'bin', 'python'), '#!/bin/sh\n', 'utf8')
      await chmod(join(dead, 'bin', 'python'), 0o644)
      await mkdir(join(live, 'bin'), { recursive: true })
      await writeFile(join(live, 'bin', 'python'), '#!/bin/sh\n', 'utf8')
      await chmod(join(live, 'bin', 'python'), 0o755)
      expect(resolvePython('auto', [dead, live])).toBe(join(live, 'bin', 'python'))
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('falls back to python3 when no candidate env resolves', () => {
    expect(resolvePython('auto', [])).toBe('python3')
  })
})

describe('defaultEnvCandidates', () => {
  it('lists the common conda env roots and honors an active dsh-cae CONDA_PREFIX', () => {
    const home = '/home/tester'
    const env = { CONDA_PREFIX: '/home/tester/miniconda3/envs/dsh-cae' }
    const candidates = defaultEnvCandidates(home, env)
    expect(candidates[0]).toBe(env.CONDA_PREFIX)
    expect(candidates).toContain(join(home, 'miniconda3', 'envs', 'dsh-cae'))
    expect(candidates).toContain(join(home, '.conda', 'envs', 'dsh-cae'))
    expect(candidates).toContain(join('/opt', 'conda', 'envs', 'dsh-cae'))
  })

  it('splits CONDA_ENVS_PATH roots and dedupes', () => {
    const candidates = defaultEnvCandidates('/home/tester', { CONDA_ENVS_PATH: '/e1:/e2' })
    expect(candidates).toContain(join('/e1', 'dsh-cae'))
    expect(candidates).toContain(join('/e2', 'dsh-cae'))
    expect(new Set(candidates).size).toBe(candidates.length)
  })
})

describe('stageEnv', () => {
  it('puts the shipped python dir first on PYTHONPATH', () => {
    const env = stageEnv('python3', { PYTHONPATH: '/extra' })
    expect(env.PYTHONPATH).toBe(`${pythonDir()}:/extra`)
  })

  it("prepends the env's lib and bin dirs for a conda-style interpreter", async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-cae-env-'))
    try {
      const envDir = join(root, 'dsh-cae')
      await mkdir(join(envDir, 'conda-meta'), { recursive: true }) // the conda marker
      await mkdir(join(envDir, 'lib'), { recursive: true })
      const env = stageEnv(join(envDir, 'bin', 'python'), {
        LD_LIBRARY_PATH: '/opt/openfoam/evil',
        PATH: '/usr/bin:/bin',
      })
      expect(env.LD_LIBRARY_PATH).toBe(`${join(envDir, 'lib')}:/opt/openfoam/evil`)
      expect(env.PATH).toBe(`${join(envDir, 'bin')}:/usr/bin:/bin`)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('leaves LD_LIBRARY_PATH and PATH alone for a system interpreter without conda-meta', () => {
    expect(stageEnv('/usr/bin/python3', {}).LD_LIBRARY_PATH).toBeUndefined()
    expect(stageEnv('/usr/bin/python3', { LD_LIBRARY_PATH: '/keep', PATH: '/usr/bin' }).LD_LIBRARY_PATH).toBe('/keep')
    expect(stageEnv('/usr/bin/python3', { PATH: '/usr/bin' }).PATH).toBe('/usr/bin')
  })
})

describe('depsFailureMessage', () => {
  const structuralReceipt = {
    ok: false,
    missing: ['build123d', 'ccx (CalculiX binary)'],
    group: 'structural',
    diagnostics: {
      python: '/home/u/miniconda3/envs/dsh-cae/bin/python',
      pythonVersion: '3.11.16',
      ccxPath: null,
      importErrors: {
        build123d: 'ImportError: pyexpat ... undefined symbol: XML_SetAllocTrackerActivationThreshold',
      },
    },
  }

  it('embeds the interpreter, per-module import errors, and the env-poisoning hint', () => {
    const msg = depsFailureMessage('structural', structuralReceipt)
    expect(msg).toContain('interpreter: /home/u/miniconda3/envs/dsh-cae/bin/python (3.11.16)')
    expect(msg).toContain('build123d: ImportError: pyexpat')
    expect(msg).toContain('broken environment')
    expect(msg).toContain('pip install build123d')
  })

  it('keeps the missing list and install hint for legacy receipts without diagnostics', () => {
    const msg = depsFailureMessage('structural', { ok: false, missing: ['gmsh'] })
    expect(msg).toContain('missing')
    expect(msg).toContain('gmsh')
    expect(msg).toContain('pip install build123d')
    expect(msg).not.toContain('interpreter:')
  })

  it('routes the CFD hint for the cfd group', () => {
    expect(depsFailureMessage('cfd', { ok: false, missing: ['OpenFOAM bashrc'] })).toContain('openfoamBashrc')
  })
})

describe('parseRuntime', () => {
  it('passes any non-docker value through as a local command', () => {
    expect(parseRuntime('python3')).toEqual({ kind: 'local', command: 'python3' })
    expect(parseRuntime('/opt/envs/dsh-cae/bin/python'))
      .toEqual({ kind: 'local', command: '/opt/envs/dsh-cae/bin/python' })
  })

  it('extracts the image from a docker:// value', () => {
    expect(parseRuntime('docker://ghcr.io/daiyuhangsustc/dsh-cae:latest'))
      .toEqual({ kind: 'docker', image: 'ghcr.io/daiyuhangsustc/dsh-cae:latest' })
  })

  it('rejects docker:// with an empty image and shows a config example', () => {
    expect(() => parseRuntime('docker://')).toThrow(/image reference.*docker:\/\/ghcr\.io/)
  })
})

describe('dockerArgv', () => {
  it('builds a same-path-mount, read-only-plugin-mount docker run argv', () => {
    const argv = dockerArgv('img:tag', '/tmp/w', 'fixtures.fake_stage', ['--mode', 'ok'])
    expect(argv.slice(0, 3)).toEqual(['docker', 'run', '--rm'])
    expect(argv).toContain('--init')
    expect(argv).toContain('/tmp/w:/tmp/w')
    expect(argv).toContain(`${pythonDir()}:/opt/dsh-cae/python:ro`)
    const w = argv.indexOf('-w')
    expect(argv[w + 1]).toBe('/tmp/w')
    const u = argv.indexOf('-u')
    expect(argv[u + 1]).toMatch(/^\d+:\d+$/)
    expect(argv).toContain('img:tag')
    expect(argv.slice(-5)).toEqual(['python', '-m', 'dsh_cae.fixtures.fake_stage', '--mode', 'ok'])
  })
})

describe('dockerPreflight', () => {
  it('reports Docker as not installed when the binary is missing', async () => {
    await expect(dockerPreflight('img:tag', {}, { dockerBin: '/nonexistent/docker-bin' }))
      .rejects.toThrow(/Docker is not installed.*docs\.docker\.com/)
  })
})

describe('dockerSpawnEnv', () => {
  it('passes only PATH through to the docker CLI', () => {
    const env = dockerSpawnEnv({ PATH: '/usr/bin', LD_LIBRARY_PATH: '/opt/openfoam/evil', HOME: '/home/u' })
    expect(env).toEqual({ PATH: '/usr/bin' })
  })
})
