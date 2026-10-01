import { describe, expect, it } from 'vitest'
import { computePlanDigest } from '../../src/platform-release/plan.js'
import { getPlatformReleaseStatus } from '../../src/platform-release/status.js'
import type { PlatformReleaseGitHubClient, PlatformReleasePlan } from '../../src/platform-release/types.js'
import { opsBinding, opsFixture } from './supabase-fixture.js'
import { reconcileSupabaseRelease } from '../../src/platform-release/supabase-reconciliation.js'

function plan(): PlatformReleasePlan {
  const repository = (name: string, targetSha: string) => ({
    base: { kind: 'release' as const, sha: 'base', version: 'v0.45.0' },
    branch: 'main',
    commits: [],
    deploymentWorkflow: 'platform-release-deploy.yml',
    productionUrl: 'https://example.test',
    pullRequests: [],
    repository: name,
    surface: name,
    targetSha,
  })
  const value: Omit<PlatformReleasePlan, 'digest'> = {
    breakingChanges: [],
    createdAt: '2026-08-08T10:00:00.000Z',
    highestBump: 'patch',
    manualVersion: false,
    repositories: {
      dashboard: repository('findmydoc-platform/clinic-dashboard', 'dashboard-target'),
      website: repository('findmydoc-platform/website', 'website-target'),
    },
    schemaVersion: 2,
    version: 'v0.45.1',
    visualCandidates: [],
  }
  return { ...value, digest: computePlanDigest(value) }
}

describe('platform release status', () => {
  it('reports verified historical Ops evidence without dispatching or asserting current remote freshness', async () => {
    const frozen = plan()
    frozen.supabaseReconciliation = opsBinding
    frozen.digest = computePlanDigest(frozen)
    const fixture = opsFixture()
    const github = {
      ...fixture.client,
      async isAncestor() {
        return true
      },
      async findWorkflowRun() {
        return undefined
      },
      async getRelease() {
        return undefined
      },
    } as unknown as PlatformReleaseGitHubClient
    await reconcileSupabaseRelease(frozen, 'c'.repeat(64), github, fixture.store)
    fixture.events.length = 0
    const result = await getPlatformReleaseStatus(frozen, github, {
      contentDigest: 'c'.repeat(64),
      supabaseRunStore: fixture.store,
    })
    expect(result).toMatchObject({
      reconciliation: {
        fresh: false,
        environments: { preview: { phase: 'verified' }, production: { phase: 'verified' } },
      },
    })
    expect(fixture.events).toEqual(['verified:preview', 'verified:production'])
    expect(await getPlatformReleaseStatus(frozen, github)).toMatchObject({
      reconciliation: {
        fresh: false,
        environments: { preview: { phase: 'unknown' }, production: { phase: 'unknown' } },
      },
    })
  })
  it('reports a release tag that targets the wrong SHA', async () => {
    const github = {
      async findWorkflowRun() {
        return undefined
      },
      async getRelease(repository: string) {
        return {
          id: 1,
          sha: repository.endsWith('/website') ? 'wrong-sha' : 'dashboard-target',
          url: 'https://example.test',
        }
      },
    } as unknown as PlatformReleaseGitHubClient
    const result = (await getPlatformReleaseStatus(plan(), github)) as {
      problems: string[]
      repositories: { website: { releaseMatchesTargetSha: boolean } }
    }
    expect(result.repositories.website.releaseMatchesTargetSha).toBe(false)
    expect(result.problems).toEqual(['findmydoc-platform/website v0.45.1 does not point to website-target.'])
  })

  it('reports an immutable published release that is missing its manifest', async () => {
    const github = {
      async findWorkflowRun() {
        return undefined
      },
      async getRelease(repository: string) {
        return {
          body: '',
          draft: false,
          id: 1,
          immutable: repository.endsWith('/clinic-dashboard'),
          manifestAttached: !repository.endsWith('/clinic-dashboard'),
          preparedAt: '2026-08-16T12:00:00Z',
          publishedAt: '2026-08-16T12:01:00Z',
          sha: repository.endsWith('/website') ? 'website-target' : 'dashboard-target',
          url: 'https://example.test',
        }
      },
    } as unknown as PlatformReleaseGitHubClient
    const result = (await getPlatformReleaseStatus(plan(), github)) as { problems: string[] }
    expect(result.problems).toContain('findmydoc-platform/clinic-dashboard v0.45.1 is missing platform-release.json.')
  })
})
