import { describe, expect, it } from 'vitest'
import { computePlanDigest } from '../../src/platform-release/plan.js'
import { getPlatformReleaseStatus } from '../../src/platform-release/status.js'
import type { PlatformReleaseGitHubClient, PlatformReleasePlan } from '../../src/platform-release/types.js'

function plan(): PlatformReleasePlan {
  const repository = (name: string, targetSha: string) => ({
    base: { kind: 'release' as const, sha: 'base', version: 'v0.45.0' }, branch: 'main', commits: [],
    deploymentWorkflow: 'platform-release-deploy.yml', productionUrl: 'https://example.test', pullRequests: [],
    repository: name, surface: name, targetSha,
  })
  const value: Omit<PlatformReleasePlan, 'digest'> = {
    breakingChanges: [], createdAt: '2026-08-08T10:00:00.000Z', highestBump: 'patch', manualVersion: false,
    repositories: {
      dashboard: repository('findmydoc-platform/clinic-dashboard', 'dashboard-target'),
      website: repository('findmydoc-platform/website', 'website-target'),
    },
    schemaVersion: 2, version: 'v0.45.1', visualCandidates: [],
  }
  return { ...value, digest: computePlanDigest(value) }
}

describe('platform release status', () => {
  it('reports a release tag that targets the wrong SHA', async () => {
    const github = {
      async findWorkflowRun() { return undefined },
      async getRelease(repository: string) {
        return { id: 1, sha: repository.endsWith('/website') ? 'wrong-sha' : 'dashboard-target', url: 'https://example.test' }
      },
    } as unknown as PlatformReleaseGitHubClient
    const result = await getPlatformReleaseStatus(plan(), github) as {
      problems: string[]
      repositories: { website: { releaseMatchesTargetSha: boolean } }
    }
    expect(result.repositories.website.releaseMatchesTargetSha).toBe(false)
    expect(result.problems).toEqual([
      'findmydoc-platform/website v0.45.1 does not point to website-target.',
    ])
  })
})
