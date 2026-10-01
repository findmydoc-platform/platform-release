import { describe, expect, it } from 'vitest'
import { applyPlatformRelease } from '../../src/platform-release/apply.js'
import { computeReleaseContentDigest, renderRepositoryReleaseNotes } from '../../src/platform-release/content.js'
import { computePlanDigest, platformDeploymentWorkflowTitle } from '../../src/platform-release/plan.js'
import { opsBinding, opsConfig, opsFixture } from './supabase-fixture.js'
import { reconcileSupabaseRelease } from '../../src/platform-release/supabase-reconciliation.js'
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
  supabaseReconciliation: opsConfig,
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

function pullRequest(repository: string, number: number, issues: ReleaseIssue[] = []) {
  return {
    body: '',
    commitShas: [`${number}`.repeat(40).slice(0, 40)],
    issues,
    number,
    repository,
    title: `Feature ${number}`,
    url: `https://github.com/${repository}/pull/${number}`,
    visuals: [],
  }
}

function plan(): PlatformReleasePlan {
  const value: Omit<PlatformReleasePlan, 'digest'> = {
    supabaseReconciliation: opsBinding,
    breakingChanges: [],
    createdAt: '2026-08-04T12:00:00.000Z',
    highestBump: 'minor',
    manualVersion: false,
    repositories: {
      dashboard: {
        base: { kind: 'cutover', sha: 'dashboard-base' },
        branch: 'main',
        commits: [],
        deploymentWorkflow: 'platform-release-deploy.yml',
        productionUrl: 'https://clinics.findmydoc.eu',
        pullRequests: [pullRequest('findmydoc-platform/clinic-dashboard', 20)],
        repository: 'findmydoc-platform/clinic-dashboard',
        surface: 'Dashboard for clinics',
        targetSha: 'dashboard-target',
      },
      website: {
        base: { kind: 'release', sha: 'website-base', version: 'v0.45.0' },
        branch: 'main',
        commits: [],
        deploymentWorkflow: 'platform-release-deploy.yml',
        productionUrl: 'https://findmydoc.eu',
        pullRequests: [pullRequest('findmydoc-platform/website', 10)],
        repository: 'findmydoc-platform/website',
        surface: 'Public platform',
        targetSha: 'website-target',
      },
    },
    schemaVersion: 2,
    version: 'v0.46.0',
    visualCandidates: [],
  }
  return { ...value, digest: computePlanDigest(value) }
}

function content(): PlatformReleaseContent {
  return {
    changes: [
      {
        id: 'reviews',
        kind: 'feature',
        pullRequests: [
          { number: 20, repository: 'findmydoc-platform/clinic-dashboard' },
          { number: 10, repository: 'findmydoc-platform/website' },
        ],
        section: 'platform',
        summary: 'Bewertungen sind jetzt durchgängig verfügbar.',
        title: 'Bewertungen',
        visualUrls: [],
      },
    ],
    highlights: ['reviews'],
    schemaVersion: 1,
    summary: 'Bewertungen verbinden jetzt Website und Clinic Dashboard.',
  }
}

class ApplyGitHub implements PlatformReleaseGitHubClient {
  dispatches: string[] = []
  events: string[] = []
  ops = opsFixture(this.events)
  getRepositoryFile = this.ops.client.getRepositoryFile
  dispatchWorkflowRun = this.ops.client.dispatchWorkflowRun
  getWorkflowRun = this.ops.client.getWorkflowRun
  getWorkflowArtifact = this.ops.client.getWorkflowArtifact
  manifests: string[] = []
  releases: string[] = []
  releaseDetails = new Map<
    string,
    {
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
    }
  >()
  createFailureRepository?: string
  failureRepository?: string
  manifestFailureRepository?: string
  publishFailureRepository?: string
  manifestCallsInFlight = 0
  manifestByRepository = new Map<string, string>()
  lastManifestAttempt?: string
  maxManifestCallsInFlight = 0

  async isAncestor() {
    return true
  }
  async findWorkflowRun(input: { repository: string }): Promise<WorkflowRun | undefined> {
    if (!this.dispatches.includes(input.repository)) return undefined
    return {
      conclusion: this.failureRepository === input.repository ? 'failure' : 'success',
      databaseId: 1,
      displayTitle: 'release',
      status: 'completed',
      url: `https://github.com/${input.repository}/actions/runs/1`,
    }
  }
  async dispatchWorkflow(input: { repository: string }) {
    this.events.push(`deploy:${input.repository}`)
    this.dispatches.push(input.repository)
  }
  async getRelease(repository: string) {
    return this.releaseDetails.get(repository)
  }
  async getReleaseManifest(repository: string) {
    return this.manifestByRepository.get(repository)
  }
  async createDraftRelease(input: { body: string; repository: string; targetSha: string; version: string }) {
    if (this.createFailureRepository === input.repository) throw new Error('release creation failed')
    this.events.push(`draft:${input.repository}`)
    this.releases.push(input.repository)
    const details = {
      body: input.body,
      draft: true,
      id: this.releases.length,
      immutable: false,
      manifestAttached: false,
      preparedAt: '2026-08-12T11:59:00Z',
      sha: input.targetSha,
      url: `https://github.com/${input.repository}/releases/tag/${input.version}`,
    }
    this.releaseDetails.set(input.repository, details)
    return details
  }
  async publishRelease(input: { repository: string; targetSha: string }) {
    if (this.publishFailureRepository === input.repository) throw new Error('release publication failed')
    const details = this.releaseDetails.get(input.repository)
    if (!details) throw new Error('release does not exist')
    if (details.sha !== input.targetSha) throw new Error('unexpected publication target')
    const published = {
      ...details,
      draft: false,
      immutable: true,
      manifestAttached: this.manifestByRepository.has(input.repository),
      publishedAt: '2026-08-12T12:00:00Z',
    }
    this.releaseDetails.set(input.repository, published)
    this.events.push(`publish:${input.repository}`)
    return published
  }
  async setReleasePlatformPublishedAt(input: { platformPublishedAt: string; repository: string }) {
    const details = this.releaseDetails.get(input.repository)
    if (!details) throw new Error('release does not exist')
    const updated = {
      ...details,
      body: `${details.body.trim()}\n\n<!-- findmydoc-platform-published-at:${input.platformPublishedAt} -->\n`,
      platformPublishedAt: input.platformPublishedAt,
    }
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
  async compareCommits() {
    throw new Error('not used')
  }
  async getBranchSha() {
    return this.ops.client.getBranchSha()
  }
  async getLatestRelease() {
    throw new Error('not used')
  }
  async getPullRequests() {
    throw new Error('not used')
  }
}

class FounderOps implements FounderOpsReleaseClient {
  calls = 0
  constructor(
    private readonly events: string[],
    private readonly failure = false,
  ) {}
  async ingestManifest() {
    this.calls += 1
    this.events.push('founderops')
    if (this.failure) throw new Error('FounderOps failed')
    return { replayed: false, url: 'https://founder-ops.findmydoc.eu/team/releases/v0.46.0' }
  }
}

const announcementStore: PlatformReleaseAnnouncementStore = {
  async getState() {
    return undefined
  },
  async setState() {},
}

function applyInput(frozenPlan = plan()) {
  const releaseContent = content()
  return {
    announce: false,
    config,
    confirmContentDigest: computeReleaseContentDigest(releaseContent),
    confirmDigest: frozenPlan.digest,
    confirmVersion: 'v0.46.0',
    content: releaseContent,
    plan: frozenPlan,
  }
}

const apply = (
  input: Parameters<typeof applyPlatformRelease>[0],
  github: ApplyGitHub,
  founderOps: FounderOps,
  store: PlatformReleaseAnnouncementStore,
  options: Parameters<typeof applyPlatformRelease>[4] = {},
) => applyPlatformRelease(input, github, founderOps, store, { ...options, supabaseRunStore: github.ops.store })

describe('platform release apply', () => {
  it.each(['missing', 'failed'])(
    'preserves published components with verified Ops evidence and %s application evidence',
    async (state) => {
      const input = applyInput()
      const github = new ApplyGitHub()
      await reconcileSupabaseRelease(input.plan, input.confirmContentDigest, github, github.ops.store)
      github.releaseDetails.set(config.repositories.website.repository, {
        body: renderRepositoryReleaseNotes(input.plan, input.content, 'website'),
        draft: false,
        id: 1,
        immutable: true,
        manifestAttached: true,
        preparedAt: '2026-10-01T12:00:00Z',
        publishedAt: '2026-10-01T12:01:00Z',
        sha: input.plan.repositories.website.targetSha,
        url: 'https://example.test',
      })
      github.dispatches.push(config.repositories.dashboard.repository)
      if (state === 'failed') {
        github.dispatches.push(config.repositories.website.repository)
        github.failureRepository = config.repositories.website.repository
      }
      const before = [...github.dispatches]
      await expect(
        apply(input, github, new FounderOps(github.events), announcementStore, { pollIntervalMs: 0, timeoutMs: 100 }),
      ).rejects.toThrow('Published release deployment evidence is incomplete')
      expect(github.dispatches).toEqual(before)
      expect(github.ops.runs.size).toBe(2)
      expect(github.events.filter((entry) => entry.startsWith('dispatch:'))).toEqual([
        'dispatch:preview',
        'dispatch:production',
      ])
      expect(github.releases).toEqual([])
    },
  )
  it('verifies all Ops configuration before any deployment and reuses those runs after deployment failure', async () => {
    const github = new ApplyGitHub()
    github.failureRepository = config.repositories.website.repository
    const options = { pollIntervalMs: 0, timeoutMs: 100 }
    await expect(
      apply(applyInput(), github, new FounderOps(github.events), announcementStore, options),
    ).rejects.toThrow('deployment failed')
    expect(github.events.slice(0, 4)).toEqual([
      'dispatch:preview',
      'verified:preview',
      'dispatch:production',
      'verified:production',
    ])
    expect(github.ops.runs.size).toBe(2)
    github.failureRepository = undefined
    const result = await apply(applyInput(), github, new FounderOps(github.events), announcementStore, options)
    expect(result.reconciliation?.environments.production.status).toBe('verified')
    expect(github.ops.runs.size).toBe(2)
  })

  it('stops all release mutations when Preview has no authentic convergence evidence', async () => {
    const github = new ApplyGitHub()
    github.getWorkflowArtifact = async () => {
      throw new Error('missing audit')
    }
    await expect(
      apply(applyInput(), github, new FounderOps(github.events), announcementStore, {
        pollIntervalMs: 0,
        timeoutMs: 100,
      }),
    ).rejects.toThrow('Ops preview')
    expect(github.dispatches).toEqual([])
    expect(github.releases).toEqual([])
    expect(github.ops.runs.size).toBe(1)
  })
  it('preserves a published component by refusing new deployments when frozen workflow evidence is missing', async () => {
    const input = applyInput()
    const github = new ApplyGitHub()
    github.releaseDetails.set(config.repositories.website.repository, {
      body: renderRepositoryReleaseNotes(input.plan, input.content, 'website'),
      draft: false,
      id: 1,
      immutable: true,
      manifestAttached: true,
      preparedAt: '2026-10-01T12:00:00Z',
      publishedAt: '2026-10-01T12:01:00Z',
      sha: input.plan.repositories.website.targetSha,
      url: 'https://example.test',
    })
    await expect(
      apply(input, github, new FounderOps(github.events), announcementStore, {
        pollIntervalMs: 0,
        timeoutMs: 100,
      }),
    ).rejects.toThrow('Ops preview reconciliation could not be verified')
    expect(github.dispatches).toEqual([])
    expect(github.ops.runs.size).toBe(0)
    expect(github.releases).toEqual([])
  })

  it('rejects existing release content conflicts before deploying application changes', async () => {
    const input = applyInput()
    const github = new ApplyGitHub()
    github.releaseDetails.set(config.repositories.website.repository, {
      body: 'Different approved content',
      draft: true,
      id: 1,
      immutable: false,
      manifestAttached: false,
      preparedAt: '2026-10-01T12:00:00Z',
      sha: input.plan.repositories.website.targetSha,
      url: 'https://example.test',
    })
    await expect(
      apply(input, github, new FounderOps(github.events), announcementStore, {
        pollIntervalMs: 0,
        timeoutMs: 100,
      }),
    ).rejects.toThrow('release notes do not match')
    expect(github.dispatches).toEqual([])
  })

  it('binds each deployment run identity to its frozen target SHA', () => {
    const frozenPlan = plan()
    expect(platformDeploymentWorkflowTitle(frozenPlan, 'website')).toBe(
      `findmydoc v0.46.0 · ${frozenPlan.digest} · website-target`,
    )
  })

  it('uploads byte-identical manifests before FounderOps ingestion', async () => {
    const github = new ApplyGitHub()
    const founderOps = new FounderOps(github.events)
    const result = await apply(applyInput(), github, founderOps, announcementStore, {
      now: () => new Date('2026-08-12T11:59:30.000Z'),
      pollIntervalMs: 0,
      timeoutMs: 100,
    })
    expect(github.dispatches).toEqual(['findmydoc-platform/clinic-dashboard', 'findmydoc-platform/website'])
    expect(github.manifests).toHaveLength(2)
    expect(github.manifests[0]).toBe(github.manifests[1])
    expect(JSON.parse(github.manifests[0] ?? '{}')).toMatchObject({
      notificationMode: 'standard',
      publishedAt: '2026-08-12T11:59:30.000Z',
      releaseMode: 'platform',
      schemaVersion: 3,
      source: { kind: 'native' },
    })
    expect(github.maxManifestCallsInFlight).toBe(1)
    expect(github.events.indexOf('publish:findmydoc-platform/clinic-dashboard')).toBeGreaterThan(
      github.events.lastIndexOf('manifest:findmydoc-platform/website'),
    )
    expect(github.events.indexOf('founderops')).toBeGreaterThan(
      github.events.lastIndexOf('manifest:findmydoc-platform/website'),
    )
    expect(result).toMatchObject({ contentDigest: applyInput().confirmContentDigest, status: 'published' })
  })

  it('publishes no release when either deployment fails', async () => {
    const github = new ApplyGitHub()
    github.failureRepository = 'findmydoc-platform/website'
    await expect(
      apply(applyInput(), github, new FounderOps(github.events), announcementStore, {
        pollIntervalMs: 0,
        timeoutMs: 100,
      }),
    ).rejects.toThrow('deployment failed')
    expect(github.releases).toEqual([])
  })

  it('rejects a self-consistent plan that changes trusted configuration', async () => {
    const github = new ApplyGitHub()
    const untrustedPlan = plan()
    untrustedPlan.repositories.website.deploymentWorkflow = 'branch-controlled.yml'
    untrustedPlan.digest = computePlanDigest(untrustedPlan)
    await expect(
      apply(applyInput(untrustedPlan), github, new FounderOps(github.events), announcementStore),
    ).rejects.toThrow('does not match the trusted platform release configuration')
    expect(github.dispatches).toEqual([])
  })

  it('resumes after the first GitHub release without recreating it', async () => {
    const github = new ApplyGitHub()
    github.createFailureRepository = 'findmydoc-platform/website'
    await expect(
      apply(applyInput(), github, new FounderOps(github.events), announcementStore, {
        pollIntervalMs: 0,
        timeoutMs: 100,
      }),
    ).rejects.toThrow('release creation failed')
    expect(github.releases).toEqual(['findmydoc-platform/clinic-dashboard'])

    github.createFailureRepository = undefined
    await apply(applyInput(), github, new FounderOps(github.events), announcementStore, {
      pollIntervalMs: 0,
      timeoutMs: 100,
    })
    expect(github.releases).toEqual(['findmydoc-platform/clinic-dashboard', 'findmydoc-platform/website'])
  })

  it('resumes after a manifest upload failure without recreating releases', async () => {
    const github = new ApplyGitHub()
    github.manifestFailureRepository = 'findmydoc-platform/website'
    await expect(
      apply(applyInput(), github, new FounderOps(github.events), announcementStore, {
        pollIntervalMs: 0,
        timeoutMs: 100,
      }),
    ).rejects.toThrow('manifest upload failed')
    expect(github.releases).toHaveLength(2)
    expect(github.events.filter((event) => event.startsWith('publish:'))).toEqual([])

    github.manifestFailureRepository = undefined
    await apply(applyInput(), github, new FounderOps(github.events), announcementStore, {
      pollIntervalMs: 0,
      timeoutMs: 100,
    })
    expect(github.releases).toHaveLength(2)
  })

  it('resumes a partial publication with the same manifest', async () => {
    const github = new ApplyGitHub()
    github.publishFailureRepository = 'findmydoc-platform/website'
    await expect(
      apply(applyInput(), github, new FounderOps(github.events), announcementStore, {
        pollIntervalMs: 0,
        timeoutMs: 100,
      }),
    ).rejects.toThrow('release publication failed')
    const firstManifest = github.manifests[0]
    expect(github.releaseDetails.get('findmydoc-platform/clinic-dashboard')?.draft).toBe(false)
    expect(github.releaseDetails.get('findmydoc-platform/website')?.draft).toBe(true)

    github.publishFailureRepository = undefined
    await apply(applyInput(), github, new FounderOps(github.events), announcementStore, {
      pollIntervalMs: 0,
      timeoutMs: 100,
    })
    expect(github.lastManifestAttempt).toBe(firstManifest)
    expect([...github.releaseDetails.values()].every((release) => release.draft === false)).toBe(true)
  })

  it('fails closed when a published immutable release is missing its manifest', async () => {
    const github = new ApplyGitHub()
    await apply(applyInput(), github, new FounderOps(github.events), announcementStore, {
      pollIntervalMs: 0,
      timeoutMs: 100,
    })
    const dashboard = github.releaseDetails.get('findmydoc-platform/clinic-dashboard')!
    github.releaseDetails.set('findmydoc-platform/clinic-dashboard', {
      ...dashboard,
      immutable: true,
      manifestAttached: false,
    })
    github.manifestByRepository.delete('findmydoc-platform/clinic-dashboard')

    await expect(
      apply(applyInput(), github, new FounderOps(github.events), announcementStore, {
        pollIntervalMs: 0,
        timeoutMs: 100,
      }),
    ).rejects.toThrow('immutable and missing platform-release.json')
  })

  it('heals the live partial state with only the website manifest present', async () => {
    const github = new ApplyGitHub()
    github.manifestFailureRepository = 'findmydoc-platform/clinic-dashboard'
    await expect(
      apply(applyInput(), github, new FounderOps(github.events), announcementStore, {
        pollIntervalMs: 0,
        timeoutMs: 100,
      }),
    ).rejects.toThrow('manifest upload failed')
    expect(github.lastManifestAttempt).toBeDefined()

    github.manifestByRepository.set('findmydoc-platform/website', github.lastManifestAttempt ?? '')
    github.manifestFailureRepository = undefined
    await apply(applyInput(), github, new FounderOps(github.events), announcementStore, {
      pollIntervalMs: 0,
      timeoutMs: 100,
    })

    expect(github.manifests).toHaveLength(1)
    expect(github.manifestByRepository.get('findmydoc-platform/clinic-dashboard')).toBe(github.lastManifestAttempt)
    expect(github.releases).toHaveLength(2)
  })

  it('resumes after FounderOps failure with an identical manifest and no duplicate releases', async () => {
    const github = new ApplyGitHub()
    await expect(
      apply(applyInput(), github, new FounderOps(github.events, true), announcementStore, {
        pollIntervalMs: 0,
        timeoutMs: 100,
      }),
    ).rejects.toThrow('FounderOps failed')
    const firstManifest = github.manifests[0]
    const replay = new FounderOps(github.events)
    await apply(applyInput(), github, replay, announcementStore, { pollIntervalMs: 0, timeoutMs: 100 })
    expect(github.releases).toHaveLength(2)
    expect(github.manifests.every((manifest) => manifest === firstManifest)).toBe(true)
    expect(replay.calls).toBe(1)
  })
})
