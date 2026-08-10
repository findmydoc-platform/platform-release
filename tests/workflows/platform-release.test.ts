import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'

const readWorkflow = (name: string) => readFile(new URL(`../../.github/workflows/${name}`, import.meta.url), 'utf8')

describe('platform release workflows', () => {
  it('keeps plan as the default and requires explicit apply inputs', async () => {
    const workflow = await readWorkflow('platform-release.yml')
    expect(workflow).toContain('default: plan')
    expect(workflow).toContain("if: inputs.mode == 'apply'")
    expect(workflow).toContain('test "$WORKFLOW_REF" = "refs/heads/main"')
    expect(workflow).toContain('--confirm-digest "$CONFIRM_DIGEST"')
    expect(workflow).toContain('--confirm-version "$CONFIRM_VERSION"')
    expect(workflow).toContain('--apply')
    expect(workflow).toContain('run-id: ${{ inputs.plan_run_id }}')
  })

  it('uses a short-lived app token for cross-repository operations', async () => {
    const workflow = await readWorkflow('platform-release.yml')
    expect(workflow).toContain('actions/create-github-app-token@fee1f7d63c2ff003460e3d139729b119787bc349')
    expect(workflow).toContain('PLATFORM_RELEASE_APP_ID')
    expect(workflow).toContain('PLATFORM_RELEASE_APP_PRIVATE_KEY')
    expect(workflow).toContain('GH_TOKEN: ${{ steps.app-token.outputs.token }}')
    expect(workflow).toContain('Verify plan artifact provenance')
    expect(workflow).toContain('test "$source_branch" = "main"')
  })

  it.each([
    'reusable-deploy-dashboard.yml',
    'reusable-deploy-website.yml',
  ])('checks out and validates the exact frozen SHA in %s', async (name) => {
    const workflow = await readWorkflow(name)
    expect(workflow).toContain('ref: ${{ inputs.target_sha }}')
    expect(workflow).toContain('persist-credentials: false')
    expect(workflow).toContain('git merge-base --is-ancestor "$TARGET_SHA" origin/main')
    expect(workflow).toContain('PLAN_DIGEST: ${{ inputs.plan_digest }}')
  })

  it('preserves the dashboard production validation depth', async () => {
    const workflow = await readWorkflow('reusable-deploy-dashboard.yml')
    expect(workflow).toContain('pnpm exec playwright install --with-deps chromium')
    expect(workflow).toContain('pnpm test:all')
  })
})
