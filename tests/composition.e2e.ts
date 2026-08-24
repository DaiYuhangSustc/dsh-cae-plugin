// Loader-composition proof against a local harness checkout (opt-in).
//
// Gate: DSH_COMPOSITION=1 plus DSH_HARNESS_DIR pointing at a harness checkout.
// The default local run must stay green, so the suite skips unless both hold.
//
// Route: `pnpm dsh --profile headless --patch <overlay> --dump-config` in the
// harness checkout. The dump composes the profile's bundle patch layers plus
// our `--patch` overlay through the include plugin's real patch algorithm
// (boot-free, no `!!js` evaluation, no API key), and prints the resulting
// entry tree — proving the overlay's plugin row survives real composition.
import { describe, expect, it } from 'vitest'
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const harness = process.env.DSH_HARNESS_DIR
const enabled = process.env.DSH_COMPOSITION === '1'
const hasHarness = harness !== undefined && existsSync(join(harness, 'packages'))
const entry = resolve('lib/index.js')

describe.skipIf(!enabled || !hasHarness)('loader composition (opt-in)', () => {
  it('composed entry tree contains the cae row', { timeout: 180_000 }, async () => {
    expect(existsSync(entry)).toBe(true)
    // Isolated DSH_HOME keeps the auto-initialized headless profile template
    // and the rewritten profile root out of the real home and both repos.
    const sandbox = await mkdtemp(join(tmpdir(), 'dsh-cae-composition-'))
    try {
      const overlay = join(sandbox, 'patch.yml')
      await writeFile(overlay, `- insert:\n    - id: cae\n      name: ${entry}\n`, 'utf8')
      const res = spawnSync('pnpm', ['dsh', '--profile', 'headless', '--patch', overlay, '--dump-config'],
        { cwd: harness, encoding: 'utf8', timeout: 120_000, env: { ...process.env, DSH_HOME: sandbox } })
      // Profile init installs node_modules into the sandbox; include the spawn
      // error so a null status (pnpm missing / timeout kill) shows its cause.
      expect(res.status, `${res.error?.message ?? ''}\n${res.stderr}`).toBe(0)
      // The dump prints one commented layer per source; our overlay is labeled
      // by its absolute path and must contribute the cae plugin row.
      expect(res.stdout).toContain(overlay)
      expect(res.stdout).toContain('id: cae')
      expect(res.stdout).toContain(entry)
    } finally {
      await rm(sandbox, { recursive: true, force: true })
    }
  })
})
