import { describe, expect, it, vi } from 'vitest'
import { computePlanDigest, createPlatformReleasePlan, validatePlatformReleasePlan } from '../../src/platform-release/plan.js'
import { opsConfig } from './supabase-fixture.js'
import type {
  PlatformReleaseConfig,
  PlatformReleaseGitHubClient,
  ReleaseCommit,
  ReleasePullRequest,
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
  async isAncestor() {
    return true
  }
  async compareCommits(repository: string) {
    if (this.breaking && repository.endsWith('/website')) {
      return [{ ...commit('breaking', 'feat!: replace API'), bump: 'major' as const }]
    }
    return repository.endsWith('/website')
      ? [commit('website-commit', 'feat(reviews): add public reviews')]
      : [commit('dashboard-commit', 'fix(reviews): correct moderation state')]
  }
  async getPullRequests(): Promise<ReleasePullRequest[]> {
    return []
  }
  async createDraftRelease() {
    throw new Error('not used')
  }
  async dispatchWorkflow() {
    throw new Error('not used')
  }
  async findWorkflowRun() {
    return undefined
  }
  async getRelease() {
    return undefined
  }
  async getReleaseManifest() {
    return undefined
  }
  async ensureReleaseManifest() {
    throw new Error('not used')
  }
  async publishRelease() {
    throw new Error('not used')
  }
  async setReleasePlatformPublishedAt() {
    throw new Error('not used')
  }
}

describe('platform release planning', () => {
  it('plans without reading Ops or binding Auth configuration, including with historical config', async () => {
    const github = Object.assign(new PlanningGitHub(), {
      getRepositoryFile: vi.fn(async () => {
        throw new Error('Auth configuration must not be inspected')
      }),
    })
    const branches = vi.spyOn(github, 'getBranchSha')
    const plan = await createPlatformReleasePlan({ config: { ...config, supabaseReconciliation: opsConfig } }, github)
    expect(plan.supabaseReconciliation).toBeUndefined()
    expect(github.getRepositoryFile).not.toHaveBeenCalled()
    expect(branches.mock.calls.map(([repository]) => repository).sort()).toEqual([
      'findmydoc-platform/clinic-dashboard',
      'findmydoc-platform/website',
    ])
  })
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

  it('freezes a native plan with redacted GitHub metadata', async () => {
    const github = new PlanningGitHub()
    vi.spyOn(github, 'compareCommits').mockResolvedValue([
      commit('release-commit', 'feat: add reviews\n\nSigned-off-by: Example <person@example.com>'),
    ])
    vi.spyOn(github, 'getPullRequests').mockResolvedValue([{
      body: 'Contact person@example.com. See /home/example/private and http://127.0.0.1:3000/check.',
      commitShas: ['release-commit'],
      issues: [],
      number: 42,
      repository: config.repositories.website.repository,
      title: 'feat: add reviews',
      url: 'https://github.com/findmydoc-platform/website/pull/42',
      visuals: [],
    }])

    const plan = await createPlatformReleasePlan({ config }, github)
    expect(plan.repositories.website.commits[0]?.message).toContain('Signed-off-by: Example <[redacted-email]>')
    expect(plan.repositories.website.pullRequests[0]).toMatchObject({
      body: 'Contact [redacted-email]. See [redacted-local-path] and [redacted-local-url]',
      url: 'https://github.com/findmydoc-platform/website/pull/42',
    })
    expect(() => validatePlatformReleasePlan(plan)).not.toThrow()
  })

  it('accepts an earlier frozen plan with its original digest', async () => {
    const plan = await createPlatformReleasePlan({ config }, new PlanningGitHub())
    plan.repositories.website.commits[0]!.message += '\n\nSigned-off-by: Example <person@example.com>'
    plan.digest = computePlanDigest(plan)

    expect(() => validatePlatformReleasePlan(plan)).not.toThrow()
  })
})
