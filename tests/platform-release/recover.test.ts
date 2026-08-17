import { describe, expect, it, vi } from 'vitest'
import { computeReleaseContentDigest, renderRepositoryReleaseNotes } from '../../src/platform-release/content.js'
import { createPlatformReleaseManifest, createPlatformReleaseManifestV3, serializePlatformReleaseManifest, serializeReleaseManifest } from '../../src/platform-release/manifest.js'
import { computePlanDigest } from '../../src/platform-release/plan.js'
import {
  inspectImmutableManifestGapRecovery,
  recoverImmutableManifestGap,
  type ImmutableManifestGapRecoveryInput,
} from '../../src/platform-release/recover.js'
import type {
  FounderOpsReleaseClient,
  PlatformReleaseAnnouncementStore,
  PlatformReleaseConfig,
  PlatformReleaseContent,
  PlatformReleaseDetails,
  PlatformReleaseGitHubClient,
  PlatformReleasePlan,
  PlatformRepositoryKey,
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
      branch: 'main', cutoverSha: 'website-base', deploymentWorkflow: 'platform-release-deploy.yml',
      displayName: 'Website', productionUrl: 'https://findmydoc.eu',
      repository: 'findmydoc-platform/website', surface: 'Public platform',
    },
  },
  schemaVersion: 1,
}

function frozenPlan(): PlatformReleasePlan {
  const repository = (key: PlatformRepositoryKey) => {
    const configured = config.repositories[key]
    const number = key === 'dashboard' ? 20 : 10
    const targetSha = (key === 'dashboard' ? 'd' : 'e').repeat(40)
    const commitSha = (key === 'dashboard' ? 'a' : 'b').repeat(40)
    return {
      base: { kind: 'cutover' as const, sha: `${key}-base` },
      branch: configured.branch,
      commits: [{ bump: 'minor' as const, message: `feat: frozen ${key}`, sha: commitSha, url: `https://github.com/${configured.repository}/commit/${commitSha}` }],
      deploymentWorkflow: configured.deploymentWorkflow,
      productionUrl: configured.productionUrl,
      pullRequests: [{
        body: '', commitShas: [commitSha], issues: [], number, repository: configured.repository,
        title: `Frozen ${key} change`, url: `https://github.com/${configured.repository}/pull/${number}`, visuals: [],
      }],
      repository: configured.repository,
      surface: configured.surface,
      targetSha,
    }
  }
  const value: Omit<PlatformReleasePlan, 'digest'> = {
    breakingChanges: [], createdAt: '2026-08-14T10:00:00.000Z', highestBump: 'minor', manualVersion: false,
    repositories: { dashboard: repository('dashboard'), website: repository('website') },
    schemaVersion: 2, version: 'v0.46.0', visualCandidates: [],
  }
  return { ...value, digest: computePlanDigest(value) }
}

function approvedContent(): PlatformReleaseContent {
  return {
    changes: [{
      id: 'frozen-platform-change', kind: 'feature', pullRequests: [
        { number: 20, repository: config.repositories.dashboard.repository },
        { number: 10, repository: config.repositories.website.repository },
      ], section: 'platform', summary: 'Die freigegebene Änderung ist auf beiden Oberflächen verfügbar.',
      title: 'Freigegebene Plattformänderung', visualUrls: [],
    }],
    highlights: ['frozen-platform-change'], schemaVersion: 1,
    summary: 'Die freigegebene Plattformänderung ist jetzt verfügbar.',
  }
}

function releaseDetails(plan: PlatformReleasePlan, content: PlatformReleaseContent): Record<PlatformRepositoryKey, PlatformReleaseDetails> {
  return Object.fromEntries((['dashboard', 'website'] as PlatformRepositoryKey[]).map((key) => {
    const repository = plan.repositories[key]
    return [key, {
      body: renderRepositoryReleaseNotes(plan, content, key), draft: false, id: key === 'dashboard' ? 1 : 2,
      immutable: key === 'dashboard', manifestAttached: key === 'website',
      platformPublishedAt: '2026-08-14T12:00:00.000Z', preparedAt: '2026-08-14T11:59:00.000Z',
      publishedAt: '2026-08-14T12:00:00.000Z', sha: repository.targetSha,
      url: `https://github.com/${repository.repository}/releases/tag/${plan.version}`,
    }]
  })) as Record<PlatformRepositoryKey, PlatformReleaseDetails>
}

function workflowRuns(plan: PlatformReleasePlan): Record<PlatformRepositoryKey, WorkflowRun> {
  return Object.fromEntries((['dashboard', 'website'] as PlatformRepositoryKey[]).map((key) => [key, {
    conclusion: 'success', databaseId: key === 'dashboard' ? 101 : 102, displayTitle: 'frozen release', status: 'completed',
    url: `https://github.com/${plan.repositories[key].repository}/actions/runs/${key === 'dashboard' ? 101 : 102}`,
  }])) as Record<PlatformRepositoryKey, WorkflowRun>
}

class RecoveryGitHub implements PlatformReleaseGitHubClient {
  readonly assets = new Map<string, string>()
  readonly mutatingCalls: string[] = []

  constructor(
    readonly plan: PlatformReleasePlan,
    readonly releases: Record<PlatformRepositoryKey, PlatformReleaseDetails>,
    readonly workflows: Record<PlatformRepositoryKey, WorkflowRun>,
  ) {}

  private key(repository: string): PlatformRepositoryKey {
    return repository === config.repositories.dashboard.repository ? 'dashboard' : 'website'
  }

  async isAncestor() { return true }
  async findWorkflowRun(input: { repository: string }) { return this.workflows[this.key(input.repository)] }
  async getRelease(repository: string) { return this.releases[this.key(repository)] }
  async getReleaseManifest(repository: string) { return this.assets.get(repository) }
  async compareCommits() { throw new Error('recovery must not compare new commits') }
  async getBranchSha() { throw new Error('recovery must not read a new target SHA') }
  async getLatestRelease() { throw new Error('recovery must not calculate a new version') }
  async getPullRequests() { throw new Error('recovery must not discover new pull requests') }
  async createDraftRelease() { this.mutatingCalls.push('create release'); throw new Error('not allowed') }
  async dispatchWorkflow() { this.mutatingCalls.push('deploy'); throw new Error('not allowed') }
  async ensureReleaseManifest() { this.mutatingCalls.push('upload manifest'); throw new Error('not allowed') }
  async publishRelease() { this.mutatingCalls.push('publish release'); throw new Error('not allowed') }
  async setReleasePlatformPublishedAt() { this.mutatingCalls.push('edit release'); throw new Error('not allowed') }
}

function fixture(): { github: RecoveryGitHub; input: ImmutableManifestGapRecoveryInput } {
  const plan = frozenPlan()
  const content = approvedContent()
  const releases = releaseDetails(plan, content)
  const workflows = workflowRuns(plan)
  const manifest = createPlatformReleaseManifest({
    config, content, contentDigest: computeReleaseContentDigest(content), plan, releases, workflows,
  })
  const serializedManifest = serializePlatformReleaseManifest(manifest)
  delete releases.dashboard.platformPublishedAt
  delete releases.website.platformPublishedAt
  const github = new RecoveryGitHub(plan, releases, workflows)
  github.assets.set(config.repositories.website.repository, serializedManifest)
  return {
    github,
    input: {
      announce: false, config, confirmContentDigest: manifest.contentDigest, confirmDigest: plan.digest,
      confirmManifestDigest: manifest.manifestDigest,
      confirmMissingManifestRepository: config.repositories.dashboard.repository,
      confirmMissingPlatformPublishedAt: true,
      confirmMutableManifestRepository: config.repositories.website.repository,
      confirmVersion: plan.version, content, manifest, plan, serializedManifest,
    },
  }
}

function fixtureV3(): { github: RecoveryGitHub; input: ImmutableManifestGapRecoveryInput } {
  const plan = frozenPlan()
  const content = approvedContent()
  const releases = releaseDetails(plan, content)
  const workflows = workflowRuns(plan)
  const manifest = createPlatformReleaseManifestV3({
    config, content, contentDigest: computeReleaseContentDigest(content), plan, releases, workflows,
  })
  const serializedManifest = serializeReleaseManifest(manifest)
  const github = new RecoveryGitHub(plan, releases, workflows)
  github.assets.set(config.repositories.website.repository, serializedManifest)
  return {
    github,
    input: {
      announce: false, config, confirmContentDigest: manifest.contentDigest, confirmDigest: plan.digest,
      confirmManifestDigest: manifest.manifestDigest,
      confirmMissingManifestRepository: config.repositories.dashboard.repository,
      confirmMutableManifestRepository: config.repositories.website.repository,
      confirmPlatformPublishedAt: manifest.publishedAt,
      confirmVersion: plan.version, content, manifest, plan, serializedManifest,
    },
  }
}

describe('immutable release manifest-gap recovery', () => {
  it('preflights only the original frozen plan without discovering or mutating newer state', async () => {
    const { github, input } = fixture()
    await expect(inspectImmutableManifestGapRecovery(input, github)).resolves.toMatchObject({
      missingManifestRepository: config.repositories.dashboard.repository,
      status: 'ready', version: 'v0.46.0',
    })
    expect(github.mutatingCalls).toEqual([])
  })

  it('recovers the native Manifest v3 format emitted by current apply runs', async () => {
    const { github, input } = fixtureV3()
    await expect(inspectImmutableManifestGapRecovery(input, github)).resolves.toMatchObject({
      platformPublishedAt: input.manifest.publishedAt,
      status: 'ready',
      version: input.manifest.version,
    })
    expect(github.mutatingCalls).toEqual([])
  })

  it('fails closed when more than the confirmed immutable release is missing the manifest', async () => {
    const { github, input } = fixture()
    github.assets.clear()
    github.releases.website.manifestAttached = false
    await expect(inspectImmutableManifestGapRecovery(input, github)).rejects.toThrow('byte-identical approved manifest')
  })

  it('requires the exact legacy publication metadata and mutability state to be explicit', async () => {
    const { github, input } = fixture()
    github.releases.website.platformPublishedAt = input.manifest.publishedAt
    await expect(inspectImmutableManifestGapRecovery(input, github)).rejects.toThrow('missing legacy platform publication metadata')

    delete github.releases.website.platformPublishedAt
    github.releases.website.immutable = true
    await expect(inspectImmutableManifestGapRecovery(input, github)).rejects.toThrow('confirmed mutable manifest-bearing release')
  })

  it('rejects a self-consistent manifest whose deployment provenance differs', async () => {
    const { github, input } = fixture()
    const alteredWorkflows = { ...github.workflows, website: { ...github.workflows.website, url: 'https://github.com/other/run' } }
    const manifestReleases = Object.fromEntries((['dashboard', 'website'] as PlatformRepositoryKey[]).map((key) => [key, {
      ...github.releases[key],
      platformPublishedAt: input.manifest.publishedAt,
    }])) as Record<PlatformRepositoryKey, PlatformReleaseDetails>
    const alteredManifest = createPlatformReleaseManifest({
      config, content: input.content, contentDigest: input.confirmContentDigest, plan: input.plan,
      releases: manifestReleases, workflows: alteredWorkflows,
    })
    const alteredInput = {
      ...input,
      confirmManifestDigest: alteredManifest.manifestDigest,
      manifest: alteredManifest,
      serializedManifest: serializePlatformReleaseManifest(alteredManifest),
    }
    github.assets.set(config.repositories.website.repository, alteredInput.serializedManifest)
    await expect(inspectImmutableManifestGapRecovery(alteredInput, github)).rejects.toThrow('deployment URL is untrusted')
  })

  it('ingests the exact manifest and sends one announcement without release or deployment mutations', async () => {
    const { github, input } = fixture()
    const founderOps: FounderOpsReleaseClient = {
      ingestManifest: vi.fn(async () => ({ replayed: false, url: 'https://founder-ops.findmydoc.eu/team/releases/v0.46.0' })),
    }
    const states: string[] = []
    const store: PlatformReleaseAnnouncementStore = {
      async getState() { return undefined },
      async setState(value) { states.push(value.state) },
    }
    const fetchImpl = vi.fn(async () => new Response(null, { status: 200 }))
    await expect(recoverImmutableManifestGap({
      ...input,
      announce: true,
      webhook: 'https://chat.googleapis.com/v1/spaces/example/messages?key=key&token=token',
    }, github, founderOps, store, { fetchImpl })).resolves.toMatchObject({ announcement: 'sent', status: 'recovered' })
    expect(founderOps.ingestManifest).toHaveBeenCalledWith({
      manifest: input.serializedManifest,
      manifestDigest: input.manifest.manifestDigest,
    })
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    expect(states).toEqual(['pending', 'sent'])
    expect(github.mutatingCalls).toEqual([])
  })
})
