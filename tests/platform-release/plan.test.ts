import { describe, expect, it } from 'vitest'
import { createPlatformReleasePlan, validatePlatformReleasePlan } from '../../src/platform-release/plan.js'
import type {
  PlatformReleaseConfig,
  PlatformReleaseGitHubClient,
  ReleaseCommit,
} from '../../src/platform-release/types.js'

const config: PlatformReleaseConfig = {
  founderOps: { baseUrl: 'https://founder-ops.findmydoc.eu', ingestPath: '/api/team/platform-releases/v1/releases' },
  platformBaselineVersion: 'v0.45.0',
  repositories: {
    dashboard: {
      branch: 'main',
      cutoverSha: 'dashboard-base',
      deploymentWorkflow: 'platform-release-deploy.yml',
      displayName: 'Clinic Dashboard',
      productionUrl: 'https://clinics.findmydoc.eu',
      repository: 'findmydoc-platform/clinic-dashboard',
      surface: 'Dashboard for clinics',
    },
    website: {
      branch: 'main',
      deploymentWorkflow: 'platform-release-deploy.yml',
      displayName: 'Website',
      productionUrl: 'https://findmydoc.eu',
      repository: 'findmydoc-platform/website',
      surface: 'Public platform',
    },
  },
  schemaVersion: 1,
}

function commit(sha: string, message: string): ReleaseCommit {
  return { bump: message.startsWith('feat') ? 'minor' : 'patch', message, sha, url: `https://example.test/${sha}` }
}

class PlanningGitHub implements PlatformReleaseGitHubClient {
  breaking = false

  async getLatestRelease(repository: string) {
    return repository.endsWith('/website') ? { sha: 'website-base', version: 'v0.45.0' } : undefined
  }
  async getBranchSha(repository: string) {
    return repository.endsWith('/website') ? 'website-target' : 'dashboard-target'
  }
  async isAncestor() { return true }
  async compareCommits(repository: string) {
    if (this.breaking && repository.endsWith('/website')) {
      return [{ ...commit('breaking', 'feat!: replace API'), bump: 'major' as const }]
    }
    return repository.endsWith('/website')
      ? [commit('website-commit', 'feat(reviews): add public reviews')]
      : [commit('dashboard-commit', 'fix(reviews): correct moderation state')]
  }
  async getPullRequests() { return [] }
  async createDraftRelease() { throw new Error('not used') }
  async dispatchWorkflow() { throw new Error('not used') }
  async findWorkflowRun() { return undefined }
  async getRelease() { return undefined }
  async ensureReleaseManifest() { throw new Error('not used') }
  async publishRelease() { throw new Error('not used') }
  async setReleasePlatformPublishedAt() { throw new Error('not used') }
}

describe('platform release planning', () => {
  it('freezes both repositories and selects the highest combined bump', async () => {
    const plan = await createPlatformReleasePlan({ config }, new PlanningGitHub())
    expect(plan.version).toBe('v0.46.0')
    expect(plan.repositories.website.targetSha).toBe('website-target')
    expect(plan.repositories.dashboard.base).toEqual({ kind: 'cutover', sha: 'dashboard-base' })
    expect(plan.highestBump).toBe('minor')
    expect(() => validatePlatformReleasePlan(plan)).not.toThrow()
  })

  it('requires a manual version for breaking changes', async () => {
    const github = new PlanningGitHub()
    github.breaking = true
    await expect(createPlatformReleasePlan({ config }, github)).rejects.toThrow(
      'Breaking changes require an explicit manual platform version.',
    )
    await expect(createPlatformReleasePlan({ config, manualVersion: 'v1.0.0' }, github)).resolves.toMatchObject({
      manualVersion: true,
      version: 'v1.0.0',
    })
  })

  it('detects changes to a frozen plan', async () => {
    const plan = await createPlatformReleasePlan({ config }, new PlanningGitHub())
    plan.repositories.website.targetSha = 'tampered'
    expect(() => validatePlatformReleasePlan(plan)).toThrow('digest mismatch')
  })
})
