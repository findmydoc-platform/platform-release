import { execFileSync } from 'node:child_process'
import { chmod, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { parse } from 'yaml'

const sha = 'a'.repeat(40)

async function runRestore(status: string, ref = sha) {
  const directory = await mkdtemp(join(tmpdir(), 'release-archive-test-'))
  try {
    const workflow = parse(await readFile(new URL('../../.github/workflows/platform-release.yml', import.meta.url), 'utf8'))
    const step = workflow.jobs.apply.steps.find((value: { name?: string }) => value.name === 'Restore immutable Ops archive artifacts')
    expect(step.env.GH_TOKEN).toBe('${{ steps.ops-token.outputs.token }}')
    expect(step.env).not.toHaveProperty('ARCHIVE_PLAN')
    const bin = join(directory, 'bin')
    await mkdir(bin)
    await writeFile(join(bin, 'gh'), `#!/bin/sh
case "$2" in
  repos/findmydoc-platform/ops/compare/${sha}...main) printf '%s' "$TEST_STATUS" ;;
  repos/findmydoc-platform/ops/contents/platform-releases/v0.54.0/plan.json?ref=${sha}) printf '%s' "$TEST_PLAN" ;;
  repos/findmydoc-platform/ops/contents/platform-releases/v0.54.0/release-content.json?ref=${sha}) printf '%s' '{"schemaVersion":1}' ;;
  *) exit 77 ;;
esac
`)
    await chmod(join(bin, 'gh'), 0o755)
    const plan = JSON.stringify({ body: 'x'.repeat(70_000) })
    let succeeded = true
    try {
      execFileSync('bash', ['-c', step.run], {
        cwd: directory,
        env: { PATH: bin + ':' + process.env.PATH, ARCHIVE_REF: ref, CONFIRM_VERSION: 'v0.54.0', TEST_STATUS: status, TEST_PLAN: plan },
        stdio: 'pipe',
      })
    } catch {
      succeeded = false
    }
    const restored = await readFile(join(directory, 'artifacts/platform-release/plan.json'), 'utf8').catch(() => null)
    return { succeeded, restored, plan }
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

describe('approved Ops archive transport', () => {
  it.each(['ahead', 'identical'])('restores files larger than the secret limit from a merged commit (%s)', async (status) => {
    const result = await runRestore(status)
    expect(result.succeeded).toBe(true)
    expect(result.restored).toBe(result.plan)
  })

  it.each(['behind', 'diverged', 'unknown'])('rejects unmerged provenance (%s)', async (status) => {
    const result = await runRestore(status)
    expect(result.succeeded).toBe(false)
    expect(result.restored).toBeNull()
  })

  it('rejects a ref containing shell syntax before invoking GitHub', async () => {
    const result = await runRestore('ahead', 'main; exit 0')
    expect(result.succeeded).toBe(false)
    expect(result.restored).toBeNull()
  })
})
