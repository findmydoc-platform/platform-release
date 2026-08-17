import { describe, expect, it } from 'vitest'
import { applyPlatformRelease } from '../../src/platform-release/apply.js'
import { computeReleaseContentDigest } from '../../src/platform-release/content.js'
import { computePlanDigest, platformDeploymentWorkflowTitle } from '../../src/platform-release/plan.js'
import type {
  FounderOpsReleaseClient,
  PlatformReleaseConfig,
  PlatformReleaseContent,
  PlatformReleaseAnnouncementStore,
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
  releaseDetails = new Map<string, {
    body: string
    draft: boolean
    id: number
    immutable: boolean
    manifestAttached: boolean
    platformPublishedAt?: string
    preparedAt: string
    publishedAt?: string
    sha: string
    url: string
  }>()
  createFailureRepository?: string
  failureRepository?: string
  manifestFailureRepository?: string
  publishFailureRepository?: string
  manifestCallsInFlight = 0
  manifestByRepository = new Map<string, string>()
  lastManifestAttempt?: string
  maxManifestCallsInFlight = 0

  async isAncestor() { return true }
  async findWorkflowRun(input: { repository: string }): Promise<WorkflowRun | undefined> {
    if (!this.dispatches.includes(input.repository)) return undefined
    return { conclusion: this.failureRepository === input.repository ? 'failure' : 'success', databaseId: 1,
      displayTitle: 'release', status: 'completed', url: `https://github.com/${input.repository}/actions/runs/1` }
  }
  async dispatchWorkflow(input: { repository: string }) { this.dispatches.push(input.repository) }
  async getRelease(repository: string) { return this.releaseDetails.get(repository) }
  async getReleaseManifest(repository: string) { return this.manifestByRepository.get(repository) }
  async createDraftRelease(input: { body: string; repository: string; targetSha: string; version: string }) {
    if (this.createFailureRepository === input.repository) throw new Error('release creation failed')
    this.events.push(`draft:${input.repository}`)
    this.releases.push(input.repository)
    const details = { body: input.body, draft: true, id: this.releases.length, immutable: false, manifestAttached: false,
      preparedAt: '2026-08-12T11:59:00Z', sha: input.targetSha,
      url: `https://github.com/${input.repository}/releases/tag/${input.version}` }
    this.releaseDetails.set(input.repository, details)
    return details
  }
  async publishRelease(input: { repository: string }) {
    if (this.publishFailureRepository === input.repository) throw new Error('release publication failed')
    const details = this.releaseDetails.get(input.repository)
    if (!details) throw new Error('release does not exist')
    const published = { ...details, draft: false, immutable: true,
      manifestAttached: this.manifestByRepository.has(input.repository), publishedAt: '2026-08-12T12:00:00Z' }
    this.releaseDetails.set(input.repository, published)
    this.events.push(`publish:${input.repository}`)
    return published
  }
  async setReleasePlatformPublishedAt(input: { platformPublishedAt: string; repository: string }) {
    const details = this.releaseDetails.get(input.repository)
    if (!details) throw new Error('release does not exist')
    const updated = { ...details,
      body: `${details.body.trim()}\n\n<!-- findmydoc-platform-published-at:${input.platformPublishedAt} -->\n`,
      platformPublishedAt: input.platformPublishedAt }
    this.releaseDetails.set(input.repository, updated)
    return updated
  }
  async ensureReleaseManifest(input: { manifest: string; repository: string }) {
    this.manifestCallsInFlight += 1
    this.maxManifestCallsInFlight = Math.max(this.maxManifestCallsInFlight, this.manifestCallsInFlight)
    this.lastManifestAttempt = input.manifest
    try {
      await Promise.resolve()
      const existing = this.manifestByRepository.get(input.repository)
      if (existing !== undefined) {
        if (existing !== input.manifest) throw new Error('existing manifest differs')
        return
      }
      if (this.manifestFailureRepository === input.repository) throw new Error('manifest upload failed')
      this.events.push(`manifest:${input.repository}`)
      this.manifests.push(input.manifest)
      this.manifestByRepository.set(input.repository, input.manifest)
    } finally {
      this.manifestCallsInFlight -= 1
    }
  }
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

const announcementStore: PlatformReleaseAnnouncementStore = {
  async getState() { return undefined },
  async setState() {},
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
    const result = await applyPlatformRelease(applyInput(), github, founderOps, announcementStore, {
      now: () => new Date('2026-08-12T11:59:30.000Z'), pollIntervalMs: 0, timeoutMs: 100,
    })
    expect(github.dispatches).toEqual(['findmydoc-platform/clinic-dashboard', 'findmydoc-platform/website'])
    expect(github.manifests).toHaveLength(2)
    expect(github.manifests[0]).toBe(github.manifests[1])
    expect(JSON.parse(github.manifests[0] ?? '{}')).toMatchObject({
      notificationMode: 'standard', publishedAt: '2026-08-12T11:59:30.000Z', releaseMode: 'platform', schemaVersion: 3,
      source: { kind: 'native' },
    })
    expect(github.maxManifestCallsInFlight).toBe(1)
    expect(github.events.indexOf('publish:findmydoc-platform/clinic-dashboard'))
      .toBeGreaterThan(github.events.lastIndexOf('manifest:findmydoc-platform/website'))
    expect(github.events.indexOf('founderops')).toBeGreaterThan(github.events.lastIndexOf('manifest:findmydoc-platform/website'))
    expect(result).toMatchObject({ contentDigest: applyInput().confirmContentDigest, status: 'published' })
  })

  it('publishes no release when either deployment fails', async () => {
    const github = new ApplyGitHub()
    github.failureRepository = 'findmydoc-platform/website'
    await expect(applyPlatformRelease(applyInput(), github, new FounderOps(github.events), announcementStore, { pollIntervalMs: 0, timeoutMs: 100 }))
      .rejects.toThrow('deployment failed')
    expect(github.releases).toEqual([])
  })

  it('rejects a self-consistent plan that changes trusted configuration', async () => {
    const github = new ApplyGitHub()
    const untrustedPlan = plan()
    untrustedPlan.repositories.website.deploymentWorkflow = 'branch-controlled.yml'
    untrustedPlan.digest = computePlanDigest(untrustedPlan)
    await expect(applyPlatformRelease(applyInput(untrustedPlan), github, new FounderOps(github.events), announcementStore))
      .rejects.toThrow('does not match the trusted platform release configuration')
    expect(github.dispatches).toEqual([])
  })

  it('resumes after the first GitHub release without recreating it', async () => {
    const github = new ApplyGitHub()
    github.createFailureRepository = 'findmydoc-platform/website'
    await expect(applyPlatformRelease(applyInput(), github, new FounderOps(github.events), announcementStore, { pollIntervalMs: 0, timeoutMs: 100 }))
      .rejects.toThrow('release creation failed')
    expect(github.releases).toEqual(['findmydoc-platform/clinic-dashboard'])

    github.createFailureRepository = undefined
    await applyPlatformRelease(applyInput(), github, new FounderOps(github.events), announcementStore, { pollIntervalMs: 0, timeoutMs: 100 })
    expect(github.releases).toEqual(['findmydoc-platform/clinic-dashboard', 'findmydoc-platform/website'])
  })

  it('resumes after a manifest upload failure without recreating releases', async () => {
    const github = new ApplyGitHub()
    github.manifestFailureRepository = 'findmydoc-platform/website'
    await expect(applyPlatformRelease(applyInput(), github, new FounderOps(github.events), announcementStore, { pollIntervalMs: 0, timeoutMs: 100 }))
      .rejects.toThrow('manifest upload failed')
    expect(github.releases).toHaveLength(2)
    expect(github.events.filter((event) => event.startsWith('publish:'))).toEqual([])

    github.manifestFailureRepository = undefined
    await applyPlatformRelease(applyInput(), github, new FounderOps(github.events), announcementStore, { pollIntervalMs: 0, timeoutMs: 100 })
    expect(github.releases).toHaveLength(2)
  })

  it('resumes a partial publication with the same manifest', async () => {
    const github = new ApplyGitHub()
    github.publishFailureRepository = 'findmydoc-platform/website'
    await expect(applyPlatformRelease(applyInput(), github, new FounderOps(github.events), announcementStore, { pollIntervalMs: 0, timeoutMs: 100 }))
      .rejects.toThrow('release publication failed')
    const firstManifest = github.manifests[0]
    expect(github.releaseDetails.get('findmydoc-platform/clinic-dashboard')?.draft).toBe(false)
    expect(github.releaseDetails.get('findmydoc-platform/website')?.draft).toBe(true)

    github.publishFailureRepository = undefined
    await applyPlatformRelease(applyInput(), github, new FounderOps(github.events), announcementStore, { pollIntervalMs: 0, timeoutMs: 100 })
    expect(github.lastManifestAttempt).toBe(firstManifest)
    expect([...github.releaseDetails.values()].every((release) => release.draft === false)).toBe(true)
  })

  it('fails closed when a published immutable release is missing its manifest', async () => {
    const github = new ApplyGitHub()
    await applyPlatformRelease(applyInput(), github, new FounderOps(github.events), announcementStore, { pollIntervalMs: 0, timeoutMs: 100 })
    const dashboard = github.releaseDetails.get('findmydoc-platform/clinic-dashboard')!
    github.releaseDetails.set('findmydoc-platform/clinic-dashboard', { ...dashboard, immutable: true, manifestAttached: false })
    github.manifestByRepository.delete('findmydoc-platform/clinic-dashboard')

    await expect(applyPlatformRelease(applyInput(), github, new FounderOps(github.events), announcementStore, { pollIntervalMs: 0, timeoutMs: 100 }))
      .rejects.toThrow('immutable and missing platform-release.json')
  })

  it('heals the live partial state with only the website manifest present', async () => {
    const github = new ApplyGitHub()
    github.manifestFailureRepository = 'findmydoc-platform/clinic-dashboard'
    await expect(applyPlatformRelease(applyInput(), github, new FounderOps(github.events), announcementStore, { pollIntervalMs: 0, timeoutMs: 100 }))
      .rejects.toThrow('manifest upload failed')
    expect(github.lastManifestAttempt).toBeDefined()

    github.manifestByRepository.set('findmydoc-platform/website', github.lastManifestAttempt ?? '')
    github.manifestFailureRepository = undefined
    await applyPlatformRelease(applyInput(), github, new FounderOps(github.events), announcementStore, { pollIntervalMs: 0, timeoutMs: 100 })

    expect(github.manifests).toHaveLength(1)
    expect(github.manifestByRepository.get('findmydoc-platform/clinic-dashboard')).toBe(github.lastManifestAttempt)
    expect(github.releases).toHaveLength(2)
  })

  it('resumes after FounderOps failure with an identical manifest and no duplicate releases', async () => {
    const github = new ApplyGitHub()
    await expect(applyPlatformRelease(applyInput(), github, new FounderOps(github.events, true), announcementStore, { pollIntervalMs: 0, timeoutMs: 100 }))
      .rejects.toThrow('FounderOps failed')
    const firstManifest = github.manifests[0]
    const replay = new FounderOps(github.events)
    await applyPlatformRelease(applyInput(), github, replay, announcementStore, { pollIntervalMs: 0, timeoutMs: 100 })
    expect(github.releases).toHaveLength(2)
    expect(github.manifests.every((manifest) => manifest === firstManifest)).toBe(true)
    expect(replay.calls).toBe(1)
  })
})
