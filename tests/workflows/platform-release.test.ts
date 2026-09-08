import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'

const readWorkflow = (name: string) => readFile(new URL(`../../.github/workflows/${name}`, import.meta.url), 'utf8')

const readNamedStep = (workflow: string, name: string): string => {
  const marker = `      - name: ${name}\n`
  const start = workflow.indexOf(marker)
  expect(start).toBeGreaterThan(-1)

  const followingNamedStep = workflow.indexOf('\n      - name:', start + marker.length)
  const followingActionStep = workflow.indexOf('\n      - uses:', start + marker.length)
  const candidates = [followingNamedStep, followingActionStep].filter((index) => index >= 0)
  const end = candidates.length > 0 ? Math.min(...candidates) : workflow.length

  return workflow.slice(start, end)
}

describe('platform release workflows', () => {
  it('keeps plan as the default and requires explicit apply inputs', async () => {
    const workflow = await readWorkflow('platform-release.yml')
    expect(workflow).toContain('default: plan')
    expect(workflow).toContain("if: inputs.mode == 'apply'")
    expect(workflow).toContain('test "$WORKFLOW_REF" = "refs/heads/main"')
    expect(workflow).toContain('--confirm-digest "$CONFIRM_DIGEST"')
    expect(workflow).toContain('--confirm-content-digest "$CONFIRM_CONTENT_DIGEST"')
    expect(workflow).toContain('--confirm-version "$CONFIRM_VERSION"')
    expect(workflow).toContain('--apply')
    expect(workflow).toContain('run-id: ${{ inputs.plan_run_id }}')
    expect(workflow).toContain('args=(\n            plan')
    expect(workflow).toContain('args=(\n            apply')
    expect(workflow).toContain('--content artifacts/platform-release/release-content.json')
    expect(workflow).not.toContain('platform-release plan\n')
    expect(workflow).not.toContain('platform-release apply\n')
  })

  it('uses a short-lived app token for cross-repository operations', async () => {
    const workflow = await readWorkflow('platform-release.yml')
    expect(workflow).toContain('actions/create-github-app-token@fee1f7d63c2ff003460e3d139729b119787bc349')
    expect(workflow).toContain('PLATFORM_RELEASE_APP_ID')
    expect(workflow).toContain('PLATFORM_RELEASE_APP_PRIVATE_KEY')
    expect(workflow).toContain('GH_TOKEN: ${{ steps.app-token.outputs.token }}')
    expect(workflow).toContain('FOUNDEROPS_PLATFORM_RELEASE_TOKEN: ${{ secrets.FOUNDEROPS_PLATFORM_RELEASE_TOKEN }}')
    expect(workflow).toContain('Verify plan artifact provenance')
    expect(workflow).toContain('test "$source_branch" = "main"')
    expect(workflow).toContain('compare/${source_head_sha}...${CURRENT_SHA}')
    expect(workflow).toContain('identical | ahead')
    expect(workflow).not.toContain('test "$source_head_sha" = "$CURRENT_SHA"')
  })

  it('runs immutable-gap recovery with read-only component access and exact legacy confirmations', async () => {
    const workflow = await readWorkflow('platform-release.yml')
    const recoverJob = workflow.slice(workflow.indexOf('\n  recover:'))
    expect(recoverJob).toContain("if: inputs.mode == 'recover'")
    expect(recoverJob).toContain('permission-actions: read')
    expect(recoverJob).toContain('permission-contents: read')
    expect(recoverJob).not.toContain('permission-actions: write')
    expect(recoverJob).not.toContain('permission-contents: write')
    expect(recoverJob).toContain('gh release download "$CONFIRM_VERSION"')
    expect(recoverJob).toContain('--confirm-manifest-digest "$CONFIRM_MANIFEST_DIGEST"')
    expect(recoverJob).toContain('--confirm-missing-manifest-repository "$CONFIRM_MISSING_MANIFEST_REPOSITORY"')
    expect(recoverJob).toContain('--confirm-mutable-manifest-repository "$CONFIRM_MUTABLE_MANIFEST_REPOSITORY"')
    expect(recoverJob).toContain('--confirm-missing-platform-published-at')
    expect(recoverJob).toContain('--apply')
    expect(recoverJob).not.toContain('Upload canonical release manifest')
  })

  it('scopes GitHub-native announcement state writes to apply and recover jobs', async () => {
    const workflow = await readWorkflow('platform-release.yml')
    const applyJob = workflow.slice(workflow.indexOf('\n  apply:'))
    expect(applyJob).toContain('deployments: write')
    expect(applyJob).toContain('GITHUB_STATE_TOKEN: ${{ github.token }}')
    expect(workflow.slice(0, workflow.indexOf('\n  apply:'))).not.toContain('deployments: write')
  })

  it.each([
    'reusable-deploy-dashboard.yml',
    'reusable-deploy-website.yml',
  ])('checks out, validates, and injects the exact frozen deployment contract in %s', async (name) => {
    const workflow = await readWorkflow(name)
    expect(workflow).toContain('ref: ${{ inputs.target_sha }}')
    expect(workflow).toContain('persist-credentials: false')
    expect(workflow).toContain('git merge-base --is-ancestor "$TARGET_SHA" origin/main')
    expect(workflow).toContain('DEPLOYMENT_COMMIT_SHA: ${{ inputs.target_sha }}')
    expect(workflow).toContain('DEPLOYMENT_ENVIRONMENT: production')
    expect(workflow).toContain('PLAN_DIGEST: ${{ inputs.plan_digest }}')
    expect(workflow).toContain('RELEASE_VERSION: ${{ inputs.platform_version }}')
    expect(workflow).toContain('[[ "$DEPLOYMENT_COMMIT_SHA" = "$TARGET_SHA" ]]')
    expect(workflow).toContain('[[ "$RELEASE_VERSION" = "$PLATFORM_VERSION" ]]')
    expect(workflow).toContain('test "$DEPLOY_REF" = "refs/heads/main"')
  })

  it('injects the frozen production contract into the website deployment boundary', async () => {
    const workflow = await readWorkflow('reusable-deploy-website.yml')
    const deployStep = readNamedStep(workflow, 'Deploy Vercel production')

    expect(deployStep).toContain('DEPLOYMENT_COMMIT_SHA: ${{ inputs.target_sha }}')
    expect(deployStep).toContain('DEPLOYMENT_ENVIRONMENT: production')
    expect(deployStep).toContain('RELEASE_VERSION: ${{ inputs.platform_version }}')
    expect(deployStep).toContain('run: bash ./.github/scripts/deploy/vercel-deploy.sh production')
  })

  it.each(['Build application', 'Build Vercel production', 'Deploy Vercel production'])(
    'injects the frozen dashboard contract into the %s step',
    async (stepName) => {
      const workflow = await readWorkflow('reusable-deploy-dashboard.yml')
      const step = readNamedStep(workflow, stepName)

      expect(step).toContain('DEPLOYMENT_COMMIT_SHA: ${{ inputs.target_sha }}')
      expect(step).toContain('DEPLOYMENT_ENVIRONMENT: production')
      expect(step).toContain('RELEASE_VERSION: ${{ inputs.platform_version }}')
    },
  )

  it('preserves the dashboard production validation depth', async () => {
    const workflow = await readWorkflow('reusable-deploy-dashboard.yml')
    expect(workflow).toContain('pnpm exec playwright install --with-deps chromium')
    expect(workflow).toContain('pnpm test:all')
    expect(workflow).toContain('pull --yes --environment=production --token="$VERCEL_TOKEN"')
    expect(workflow).toContain('--env "DEPLOYMENT_ENVIRONMENT=$DEPLOYMENT_ENVIRONMENT"')
    expect(workflow).toContain('--env "DEPLOYMENT_COMMIT_SHA=$DEPLOYMENT_COMMIT_SHA"')
    expect(workflow).toContain('--env "RELEASE_VERSION=$RELEASE_VERSION"')
    expect(workflow).not.toContain('--environment=production --git-branch')
  })
})
