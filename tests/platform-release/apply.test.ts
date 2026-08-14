import { describe, expect, it } from 'vitest'
import { applyPlatformRelease } from '../../src/platform-release/apply.js'
import { computeReleaseContentDigest } from '../../src/platform-release/content.js'
import { computePlanDigest, platformDeploymentWorkflowTitle } from '../../src/platform-release/plan.js'
import type {
  FounderOpsReleaseClient,
  PlatformReleaseConfig,
  PlatformReleaseContent,
  PlatformReleaseGitHubClient,
  PlatformReleasePlan,
  ReleaseIssue,
  WorkflowRun,
} from '../../src/platform-release/types.js'

const config: PlatformReleaseConfig = {
  founderOps: { baseUrl: 'https://founder-ops.findmydoc.eu', ingestPath: '/api/team/platform-releases/v1/releases' },
  platformBaselineVersion: 'v0.45.0',
  repositories: {
    dashboard: {
      branch: 'main', cutoverSha: 'dashboard-base', deploymentWorkflow: 'platform-release-deploy.yml',
      displayName: 'Clinic Dashboard', productionUrl: 'https://clinics.findmydoc.eu',
      repository: 'findmydoc-platform/clinic-dashboard', surface: 'Dashboard for clinics',
    },
    website: {
      branch: 'main', deploymentWorkflow: 'platform-release-deploy.yml', displayName: 'Website',
      productionUrl: 'https://findmydoc.eu', repository: 'findmydoc-platform/website', surface: 'Public platform',
    },
  },
  schemaVersion: 1,
}

function pullRequest(repository: string, number: number, issues: ReleaseIssue[] = []) {
  return {
    body: '', commitShas: [`${number}`.repeat(40).slice(0, 40)], issues, number, repository,
    title: `Feature ${number}`, url: `https://github.com/${repository}/pull/${number}`, visuals: [],
  }
}

function plan(): PlatformReleasePlan {
  const value: Omit<PlatformReleasePlan, 'digest'> = {
    breakingChanges: [], createdAt: '2026-08-04T12:00:00.000Z', highestBump: 'minor', manualVersion: false,
    repositories: {
      dashboard: {
        base: { kind: 'cutover', sha: 'dashboard-base' }, branch: 'main', commits: [],
        deploymentWorkflow: 'platform-release-deploy.yml', productionUrl: 'https://clinics.findmydoc.eu',
        pullRequests: [pullRequest('findmydoc-platform/clinic-dashboard', 20)],
        repository: 'findmydoc-platform/clinic-dashboard', surface: 'Dashboard for clinics', targetSha: 'dashboard-target',
      },
      website: {
        base: { kind: 'release', sha: 'website-base', version: 'v0.45.0' }, branch: 'main', commits: [],
        deploymentWorkflow: 'platform-release-deploy.yml', productionUrl: 'https://findmydoc.eu',
        pullRequests: [pullRequest('findmydoc-platform/website', 10)], repository: 'findmydoc-platform/website',
        surface: 'Public platform', targetSha: 'website-target',
      },
    },
    schemaVersion: 2, version: 'v0.46.0', visualCandidates: [],
  }
  return { ...value, digest: computePlanDigest(value) }
}

function content(): PlatformReleaseContent {
  return {
    changes: [
      { id: 'reviews', kind: 'feature', pullRequests: [
        { number: 20, repository: 'findmydoc-platform/clinic-dashboard' },
        { number: 10, repository: 'findmydoc-platform/website' },
      ], section: 'platform', summary: 'Bewertungen sind jetzt durchgängig verfügbar.', title: 'Bewertungen', visualUrls: [] },
    ],
    highlights: ['reviews'], schemaVersion: 1, summary: 'Bewertungen verbinden jetzt Website und Clinic Dashboard.',
  }
}

class ApplyGitHub implements PlatformReleaseGitHubClient {
  dispatches: string[] = []
  events: string[] = []
  manifests: string[] = []
  releases: string[] = []
  releaseDetails = new Map<string, { body: string; id: number; publishedAt: string; sha: string; url: string }>()
  createFailureRepository?: string
  failureRepository?: string
  manifestFailureRepository?: string

  async isAncestor() { return true }
  async findWorkflowRun(input: { repository: string }): Promise<WorkflowRun | undefined> {
    if (!this.dispatches.includes(input.repository)) return undefined
    return { conclusion: this.failureRepository === input.repository ? 'failure' : 'success', databaseId: 1,
      displayTitle: 'release', status: 'completed', url: `https://github.com/${input.repository}/actions/runs/1` }
  }
  async dispatchWorkflow(input: { repository: string }) { this.dispatches.push(input.repository) }
  async getRelease(repository: string) { return this.releaseDetails.get(repository) }
  async createRelease(input: { body: string; repository: string; targetSha: string; version: string }) {
    if (this.createFailureRepository === input.repository) throw new Error('release creation failed')
    this.events.push(`release:${input.repository}`)
    this.releases.push(input.repository)
    const details = { body: input.body, id: this.releases.length, publishedAt: '2026-08-12T12:00:00Z', sha: input.targetSha,
      url: `https://github.com/${input.repository}/releases/tag/${input.version}` }
    this.releaseDetails.set(input.repository, details)
    return details
  }
  async ensureReleaseManifest(input: { manifest: string; repository: string }) {
    if (this.manifestFailureRepository === input.repository) throw new Error('manifest upload failed')
    this.events.push(`manifest:${input.repository}`)
    this.manifests.push(input.manifest)
  }
  async setReleaseAnnouncementState() {}
  async compareCommits() { throw new Error('not used') }
  async getBranchSha() { throw new Error('not used') }
  async getLatestRelease() { throw new Error('not used') }
  async getPullRequests() { throw new Error('not used') }
}

class FounderOps implements FounderOpsReleaseClient {
  calls = 0
  constructor(private readonly events: string[], private readonly failure = false) {}
  async ingestManifest() {
    this.calls += 1
    this.events.push('founderops')
    if (this.failure) throw new Error('FounderOps failed')
    return { replayed: false, url: 'https://founder-ops.findmydoc.eu/team/releases/v0.46.0' }
  }
}

function applyInput(frozenPlan = plan()) {
  const releaseContent = content()
  return {
    announce: false, config, confirmContentDigest: computeReleaseContentDigest(releaseContent),
    confirmDigest: frozenPlan.digest, confirmVersion: 'v0.46.0', content: releaseContent, plan: frozenPlan,
  }
}

describe('platform release apply', () => {
  it('binds each deployment run identity to its frozen target SHA', () => {
    const frozenPlan = plan()
    expect(platformDeploymentWorkflowTitle(frozenPlan, 'website')).toBe(`findmydoc v0.46.0 · ${frozenPlan.digest} · website-target`)
  })

  it('uploads byte-identical manifests before FounderOps ingestion', async () => {
    const github = new ApplyGitHub()
    const founderOps = new FounderOps(github.events)
    const result = await applyPlatformRelease(applyInput(), github, founderOps, { pollIntervalMs: 0, timeoutMs: 100 })
    expect(github.dispatches).toEqual(['findmydoc-platform/clinic-dashboard', 'findmydoc-platform/website'])
    expect(github.manifests).toHaveLength(2)
    expect(github.manifests[0]).toBe(github.manifests[1])
    expect(github.events.indexOf('founderops')).toBeGreaterThan(github.events.lastIndexOf('manifest:findmydoc-platform/website'))
    expect(result).toMatchObject({ contentDigest: applyInput().confirmContentDigest, status: 'published' })
  })

  it('publishes no release when either deployment fails', async () => {
    const github = new ApplyGitHub()
    github.failureRepository = 'findmydoc-platform/website'
    await expect(applyPlatformRelease(applyInput(), github, new FounderOps(github.events), { pollIntervalMs: 0, timeoutMs: 100 }))
      .rejects.toThrow('deployment failed')
    expect(github.releases).toEqual([])
  })

  it('rejects a self-consistent plan that changes trusted configuration', async () => {
    const github = new ApplyGitHub()
    const untrustedPlan = plan()
    untrustedPlan.repositories.website.deploymentWorkflow = 'branch-controlled.yml'
    untrustedPlan.digest = computePlanDigest(untrustedPlan)
    await expect(applyPlatformRelease(applyInput(untrustedPlan), github, new FounderOps(github.events)))
      .rejects.toThrow('does not match the trusted platform release configuration')
    expect(github.dispatches).toEqual([])
  })

  it('resumes after the first GitHub release without recreating it', async () => {
    const github = new ApplyGitHub()
    github.createFailureRepository = 'findmydoc-platform/website'
    await expect(applyPlatformRelease(applyInput(), github, new FounderOps(github.events), { pollIntervalMs: 0, timeoutMs: 100 }))
      .rejects.toThrow('release creation failed')
    expect(github.releases).toEqual(['findmydoc-platform/clinic-dashboard'])

    github.createFailureRepository = undefined
    await applyPlatformRelease(applyInput(), github, new FounderOps(github.events), { pollIntervalMs: 0, timeoutMs: 100 })
    expect(github.releases).toEqual(['findmydoc-platform/clinic-dashboard', 'findmydoc-platform/website'])
  })

  it('resumes after a manifest upload failure without recreating releases', async () => {
    const github = new ApplyGitHub()
    github.manifestFailureRepository = 'findmydoc-platform/website'
    await expect(applyPlatformRelease(applyInput(), github, new FounderOps(github.events), { pollIntervalMs: 0, timeoutMs: 100 }))
      .rejects.toThrow('manifest upload failed')
    expect(github.releases).toHaveLength(2)

    github.manifestFailureRepository = undefined
    await applyPlatformRelease(applyInput(), github, new FounderOps(github.events), { pollIntervalMs: 0, timeoutMs: 100 })
    expect(github.releases).toHaveLength(2)
  })

  it('resumes after FounderOps failure with an identical manifest and no duplicate releases', async () => {
    const github = new ApplyGitHub()
    await expect(applyPlatformRelease(applyInput(), github, new FounderOps(github.events, true), { pollIntervalMs: 0, timeoutMs: 100 }))
      .rejects.toThrow('FounderOps failed')
    const firstManifest = github.manifests[0]
    const replay = new FounderOps(github.events)
    await applyPlatformRelease(applyInput(), github, replay, { pollIntervalMs: 0, timeoutMs: 100 })
    expect(github.releases).toHaveLength(2)
    expect(github.manifests.every((manifest) => manifest === firstManifest)).toBe(true)
    expect(replay.calls).toBe(1)
  })
})
