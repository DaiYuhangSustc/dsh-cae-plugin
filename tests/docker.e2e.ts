// Docker-runtime end-to-end proof against a locally built image (opt-in).
//
// Gate: DSH_CAE_DOCKER_E2E=1 plus the `dsh-cae-e2e:dev` image from Task 5's
// build (`docker build -f docker/Dockerfile -t dsh-cae-e2e:dev .`). The
// default local run must stay green, so the suite skips unless both hold.
//
// Route: runStage with `python: docker://dsh-cae-e2e:dev` — the real Task 4
// branch (preflight → dockerArgv → dockerSpawnEnv) executing real stages in
// the container through the same-path workdir mount, with the plugin's
// python/ tree mounted read-only at /opt/dsh-cae/python.
import { describe, expect, it, beforeAll, afterAll } from 'vitest'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runStage } from '../src/runner.ts'
import type { Config } from '../src/config.ts'

const enabled = process.env.DSH_CAE_DOCKER_E2E === '1'

describe.skipIf(!enabled)('docker runtime e2e', () => {
  let work: string
  let config: Config
  beforeAll(async () => {
    work = await mkdtemp(join(tmpdir(), 'dsh-cae-docker-'))
    config = { python: 'docker://dsh-cae-e2e:dev', workdir: work, stageTimeoutMs: 120_000 }
  })
  afterAll(async () => { await rm(work, { recursive: true, force: true }) })

  it('runs the deps check inside the container and reports ok with diagnostics', async () => {
    const { receipt } = await runStage(config, 'deps', ['--group', 'structural'], { logFile: 'deps.log' })
    expect(receipt.ok).toBe(true)
    expect((receipt.diagnostics as { python?: string }).python).toContain('python')
  })

  it('runs a stage through the same-path workdir mount and writes host-visible artifacts', async () => {
    const res = await runStage(config, 'fixtures.fake_stage', ['--mode', 'ok'], { logFile: 'fake.log' })
    expect(res.receipt).toEqual({ ok: true, value: 42 })
    const log = await readFile(join(work, 'fake.log'), 'utf8')
    expect(log).toContain('noise line before receipt')
  })
})
