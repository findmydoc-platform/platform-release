import { describe, expect, it } from 'vitest'
import { applyPlatformRelease } from '../../src/platform-release/apply.js'
import { computePlanDigest, platformDeploymentWorkflowTitle } from '../../src/platform-release/plan.js'
import type {
  PlatformReleaseGitHubClient,
  PlatformReleaseConfig,
  PlatformReleasePlan,
  ReleaseIssue,
  WorkflowRun,
} from '../../src/platform-release/types.js'

const config: PlatformReleaseConfig = {
  platformBaselineVersion: 'v0.45.0',
  repositories: {
    dashboard: {
      branch: 'main',
      cutoverSha: 'dashboard-base',
      deploymentWorkflow: 'platform-release-deploy.yml',
      productionUrl: 'https://clinics.findmydoc.eu',
      repository: 'findmydoc-platform/clinic-dashboard',
      surface: 'Dashboard for clinics',
    },
    website: {
      branch: 'main',
      deploymentWorkflow: 'platform-release-deploy.yml',
      productionUrl: 'https://findmydoc.eu',
      repository: 'findmydoc-platform/website',
      surface: 'Public platform',
    },
  },
  schemaVersion: 1,
}

function plan(): PlatformReleasePlan {
  const value: Omit<PlatformReleasePlan, 'digest'> = {
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
        pullRequests: [],
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
        pullRequests: [],
        repository: 'findmydoc-platform/website',
        surface: 'Public platform',
        targetSha: 'website-target',
      },
    },
    schemaVersion: 1,
    version: 'v0.46.0',
    visualCandidates: [],
  }
  return { ...value, digest: computePlanDigest(value) }
}

const notes = `## Platform release

Reviews now work consistently across findmydoc.

## Dashboard for clinics

Clinic teams can moderate reviews.

## Public platform

Patients can read published reviews.
`

class ApplyGitHub implements PlatformReleaseGitHubClient {
  comments: ReleaseIssue[] = []
  dispatches: string[] = []
  releases: string[] = []
  failureRepository?: string

  async isAncestor() { return true }
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
  async dispatchWorkflow(input: { repository: string }) { this.dispatches.push(input.repository) }
  async getRelease() { return undefined }
  async createRelease(input: { repository: string; targetSha: string; version: string }) {
    this.releases.push(input.repository)
    return { id: this.releases.length, url: `https://github.com/${input.repository}/releases/tag/${input.version}` }
  }
  async uploadReleaseManifest() {}
  async setReleaseAnnouncementState() {}
  async findIssueComment() { return false }
  async addIssueComment(input: { body: string; issue: ReleaseIssue }) { this.comments.push(input.issue) }
  async compareCommits() { throw new Error('not used') }
  async getBranchSha() { throw new Error('not used') }
  async getLatestRelease() { throw new Error('not used') }
  async getPullRequests() { throw new Error('not used') }
}

describe('platform release apply', () => {
  it('binds each deployment run identity to its frozen target SHA', () => {
    const frozenPlan = plan()
    expect(platformDeploymentWorkflowTitle(frozenPlan, 'website')).toBe(
      `findmydoc v0.46.0 · ${frozenPlan.digest} · website-target`,
    )
  })

  it('deploys both applications before creating their releases', async () => {
    const github = new ApplyGitHub()
    const result = await applyPlatformRelease({
      announce: false,
      config,
      confirmDigest: plan().digest,
      confirmVersion: 'v0.46.0',
      notes,
      plan: plan(),
    }, github, { pollIntervalMs: 0, timeoutMs: 100 })
    expect(github.dispatches).toEqual([
      'findmydoc-platform/clinic-dashboard',
      'findmydoc-platform/website',
    ])
    expect(github.releases).toEqual([
      'findmydoc-platform/clinic-dashboard',
      'findmydoc-platform/website',
    ])
    expect(result.status).toBe('published')
  })

  it('publishes no release when either deployment fails', async () => {
    const github = new ApplyGitHub()
    github.failureRepository = 'findmydoc-platform/website'
    await expect(applyPlatformRelease({
      announce: false,
      config,
      confirmDigest: plan().digest,
      confirmVersion: 'v0.46.0',
      notes,
      plan: plan(),
    }, github, { pollIntervalMs: 0, timeoutMs: 100 })).rejects.toThrow('deployment failed')
    expect(github.releases).toEqual([])
  })

  it('rejects a self-consistent plan that changes a trusted repository target', async () => {
    const github = new ApplyGitHub()
    const untrustedPlan = plan()
    untrustedPlan.repositories.website.deploymentWorkflow = 'branch-controlled.yml'
    untrustedPlan.digest = computePlanDigest(untrustedPlan)

    await expect(applyPlatformRelease({
      announce: false,
      config,
      confirmDigest: untrustedPlan.digest,
      confirmVersion: 'v0.46.0',
      notes,
      plan: untrustedPlan,
    }, github)).rejects.toThrow('does not match the trusted platform release configuration')
    expect(github.dispatches).toEqual([])
  })

  it('comments only issues in the two release repositories', async () => {
    const github = new ApplyGitHub()
    const frozenPlan = plan()
    frozenPlan.repositories.website.pullRequests = [{
      body: '',
      issues: [
        { number: 1, repository: 'findmydoc-platform/website', title: 'Website issue', url: 'https://github.com/findmydoc-platform/website/issues/1' },
        { number: 2, repository: 'findmydoc-platform/management', title: 'Management issue', url: 'https://github.com/findmydoc-platform/management/issues/2' },
      ],
      number: 10,
      repository: 'findmydoc-platform/website',
      title: 'Feature',
      url: 'https://github.com/findmydoc-platform/website/pull/10',
      visuals: [],
    }]
    frozenPlan.digest = computePlanDigest(frozenPlan)

    await applyPlatformRelease({
      announce: false,
      config,
      confirmDigest: frozenPlan.digest,
      confirmVersion: 'v0.46.0',
      notes,
      plan: frozenPlan,
    }, github, { pollIntervalMs: 0, timeoutMs: 100 })

    expect(github.comments.map((issue) => `${issue.repository}#${issue.number}`)).toEqual([
      'findmydoc-platform/website#1',
    ])
  })
})
