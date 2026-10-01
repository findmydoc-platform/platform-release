import { describe, expect, it } from 'vitest'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createProgram } from '../../src/cli.js'
import { applyPlatformRelease, rollbackPlatformRelease } from '../../src/platform-release/apply.js'
import { computeAuthMailRollbackDigest } from '../../src/platform-release/auth-mail.js'
import { computeReleaseContentDigest, renderRepositoryReleaseNotes } from '../../src/platform-release/content.js'
import { computePlanDigest, platformDeploymentWorkflowTitle } from '../../src/platform-release/plan.js'
import { MemoryAuthMailState, suppressionBinding, suppressionEvidence } from './auth-mail-fixtures.js'
import type { AuthMailContext } from '../../src/platform-release/auth-mail.js'
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
  workflowRuns = new Map<string, WorkflowRun>()

  async isAncestor() {
    return true
  }
  async findWorkflowRun(input: { repository: string; title: string }): Promise<WorkflowRun | undefined> {
    return this.workflowRuns.get(`${input.repository}:${input.title}`)
  }
  async dispatchWorkflow(input: { repository: string; inputs: Record<string, string> }) {
    this.events.push(`deploy:${input.repository}`)
    this.dispatches.push(input.repository)
    const title = `findmydoc ${input.inputs.platform_version} · ${input.inputs.plan_digest} · ${input.inputs.target_sha}`
    const databaseId = this.dispatches.length
    this.workflowRuns.set(`${input.repository}:${title}`, {
      conclusion: this.failureRepository === input.repository ? 'failure' : 'success',
      databaseId,
      displayTitle: title,
      status: 'completed',
      url: `https://github.com/${input.repository}/actions/runs/${databaseId}`,
    })
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
    throw new Error('not used')
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

function authMailInput() {
  const frozenPlan = plan()
  frozenPlan.repositories.dashboard.base = { kind: 'release', sha: 'b'.repeat(40), version: 'v0.45.0' }
  frozenPlan.repositories.website.base = { kind: 'release', sha: 'c'.repeat(40), version: 'v0.45.0' }
  frozenPlan.repositories.website.targetSha = suppressionBinding.websiteSha
  frozenPlan.authMail = suppressionBinding
  frozenPlan.digest = computePlanDigest(frozenPlan)
  return {
    ...applyInput(frozenPlan),
    config: {
      ...config,
      authMail: {
        bindingId: 'website-production',
        workflow: 'platform-release-auth-mail.yml',
      },
    },
  }
}

describe('platform release apply', () => {
  it('persists an ambiguous cutover before adapter mutation and resumes only from verified suppression', async () => {
    const github = new ApplyGitHub()
    const state = new MemoryAuthMailState()
    let enabled = false
    let cutovers = 0
    const adapter = {
      async preflight(context: AuthMailContext) {
        return suppressionEvidence(context, enabled)
      },
      async cutover() {
        expect(state.progress).toEqual({ rollback: false, state: 'rollback-required' })
        cutovers += 1
        enabled = true
        throw new Error('upstream private diagnostic')
      },
    }
    const options = { authMail: adapter, authMailState: state, pollIntervalMs: 0, timeoutMs: 100 }
    await expect(
      applyPlatformRelease(authMailInput(), github, new FounderOps(github.events), announcementStore, options),
    ).rejects.toMatchObject({
      state: 'rollback-required',
      message: 'Auth mail cutover was attempted but cannot be confirmed; operator recovery is required.',
    })
    expect(state.progress).toEqual({ rollback: false, state: 'rollback-required' })
    expect(github.dispatches).toEqual([])
    expect(github.releases).toEqual([])
    await applyPlatformRelease(authMailInput(), github, new FounderOps(github.events), announcementStore, options)
    expect(cutovers).toBe(1)
    expect(state.progress).toEqual({ rollback: false, state: 'published' })
  })

  it('stops a running apply when explicit rollback appears during its fresh deployment preflight', async () => {
    const github = new ApplyGitHub()
    const state = new MemoryAuthMailState()
    let preflights = 0
    await expect(
      applyPlatformRelease(authMailInput(), github, new FounderOps(github.events), announcementStore, {
        authMail: {
          async preflight(context) {
            preflights += 1
            if (preflights === 2) state.progress = { rollback: true, state: 'rollback-required' }
            return suppressionEvidence(context)
          },
          async cutover() {
            throw new Error('must not run')
          },
        },
        authMailState: state,
        pollIntervalMs: 0,
        timeoutMs: 100,
      }),
    ).rejects.toMatchObject({ state: 'rollback-required' })
    expect(state.progress).toEqual({ rollback: true, state: 'rollback-required' })
    expect(github.dispatches).toEqual([])
    expect(github.releases).toEqual([])
  })

  it('stops a confirmed cutover when resume finds disabled suppression without repairing it', async () => {
    const github = new ApplyGitHub()
    const state = new MemoryAuthMailState()
    state.progress = { rollback: false, state: 'cutover-applied' }
    let cutovers = 0
    await expect(
      applyPlatformRelease(authMailInput(), github, new FounderOps(github.events), announcementStore, {
        authMail: {
          async preflight(context) {
            return suppressionEvidence(context, false)
          },
          async cutover(context) {
            cutovers += 1
            return suppressionEvidence(context)
          },
        },
        authMailState: state,
        pollIntervalMs: 0,
        timeoutMs: 100,
      }),
    ).rejects.toMatchObject({ state: 'rollback-required' })
    expect(cutovers).toBe(0)
    expect(github.dispatches).toEqual([])
  })

  it('retains the irreversible publication boundary when the second publication fails', async () => {
    const github = new ApplyGitHub()
    github.publishFailureRepository = 'findmydoc-platform/website'
    const state = new MemoryAuthMailState()
    await expect(
      applyPlatformRelease(authMailInput(), github, new FounderOps(github.events), announcementStore, {
        authMail: {
          async preflight(context) {
            return suppressionEvidence(context)
          },
          async cutover() {
            throw new Error('must not run')
          },
        },
        authMailState: state,
        pollIntervalMs: 0,
        timeoutMs: 100,
      }),
    ).rejects.toMatchObject({ state: 'release-pending' })
    expect(state.progress).toEqual({ rollback: false, state: 'release-pending' })
    expect(github.releaseDetails.get('findmydoc-platform/clinic-dashboard')?.draft).toBe(false)
    const firstManifest = github.manifests[0]
    github.publishFailureRepository = undefined
    await applyPlatformRelease(authMailInput(), github, new FounderOps(github.events), announcementStore, {
      authMail: {
        async preflight(context) {
          return suppressionEvidence(context)
        },
        async cutover() {
          throw new Error('must not run')
        },
      },
      authMailState: state,
      pollIntervalMs: 0,
      timeoutMs: 100,
    })
    expect(github.dispatches).toHaveLength(2)
    expect(github.releases).toHaveLength(2)
    expect(github.lastManifestAttempt).toBe(firstManifest)
    expect(state.progress).toEqual({ rollback: false, state: 'published' })
    await expect(
      applyPlatformRelease(authMailInput(), github, new FounderOps(github.events), announcementStore, {
        authMail: {
          async preflight(context) {
            return suppressionEvidence(context, false)
          },
          async cutover() {
            throw new Error('must not run')
          },
        },
        authMailState: state,
        pollIntervalMs: 0,
        timeoutMs: 100,
      }),
    ).rejects.toMatchObject({ state: 'published' })
    expect(state.progress).toEqual({ rollback: false, state: 'published' })
  })
  it('reports the unavailable adapter as structured CLI output before requesting release credentials', async () => {
    const input = authMailInput()
    const directory = await mkdtemp(join(tmpdir(), 'auth-mail-cli-'))
    const initialExitCode = process.exitCode
    const output: string[] = []
    const github = new ApplyGitHub()
    try {
      for (const [name, value] of [
        ['plan', input.plan],
        ['content', input.content],
        ['config', input.config],
      ] as const)
        await writeFile(join(directory, `${name}.json`), JSON.stringify(value))
      await createProgram({ createGitHubClient: () => github, writeStdout: (value) => output.push(value) }).parseAsync([
        'node',
        'runner',
        'apply',
        '--plan',
        join(directory, 'plan.json'),
        '--content',
        join(directory, 'content.json'),
        '--config-path',
        join(directory, 'config.json'),
        '--confirm-digest',
        input.confirmDigest,
        '--confirm-content-digest',
        input.confirmContentDigest,
        '--confirm-version',
        input.confirmVersion,
        '--apply',
        '--json',
      ])
      expect(JSON.parse(output.join(''))).toMatchObject({
        status: 'failed',
        releaseState: 'preflight-pending',
        error: {
          message: 'The protected Website Auth mail adapter is unavailable; no Production mutation is permitted.',
        },
      })
      expect(github.dispatches).toEqual([])
    } finally {
      process.exitCode = initialExitCode
      await rm(directory, { recursive: true, force: true })
    }
  })
  it('requires a separate rollback digest, restores frozen previous SHAs and keeps suppression active', async () => {
    const input = authMailInput()
    const github = new ApplyGitHub()
    const state = new MemoryAuthMailState()
    state.progress = { rollback: false, state: 'rollback-required' }
    let commandsDisabled = false
    const adapter = {
      async preflight(context: AuthMailContext) {
        return suppressionEvidence(context)
      },
      async cutover() {
        throw new Error('must not run')
      },
      async rollback(context: AuthMailContext) {
        commandsDisabled = true
        return {
          suppression: suppressionEvidence(context),
          authCommandsDisabled: true,
          otherCommandsUnchanged: true,
        }
      },
      async verifyRollback(context: AuthMailContext) {
        return {
          suppression: suppressionEvidence(context),
          authCommandsDisabled: commandsDisabled,
          otherCommandsUnchanged: true,
          applicationShas: context.previousShas,
        }
      },
    }
    const options = { authMail: adapter, authMailState: state, pollIntervalMs: 0, timeoutMs: 100 }
    const dryRun = await rollbackPlatformRelease({ ...input, apply: false }, github, options)
    expect(dryRun.status).toBe('ready')
    expect(github.dispatches).toEqual([])
    await expect(
      rollbackPlatformRelease({ ...input, apply: true, confirmRollbackDigest: 'wrong' }, github, options),
    ).rejects.toThrow('Rollback digest')
    expect(commandsDisabled).toBe(false)
    const result = await rollbackPlatformRelease(
      {
        ...input,
        apply: true,
        confirmRollbackDigest: computeAuthMailRollbackDigest(input.plan, input.confirmContentDigest),
      },
      github,
      options,
    )
    expect(result.status).toBe('rolled-back')
    expect(commandsDisabled).toBe(true)
    expect([...github.workflowRuns.values()].map(({ displayTitle }) => displayTitle.split(' · ').at(-1))).toEqual([
      'b'.repeat(40),
      'c'.repeat(40),
    ])
    expect(github.releases).toEqual([])
    await expect(
      applyPlatformRelease(input, github, new FounderOps(github.events), announcementStore, options),
    ).rejects.toThrow('explicitly rolled back')
  })
  it.each(['application-sha', 'auth-commands', 'other-commands', 'suppression'])(
    'rejects explicit rollback when final %s evidence is inconsistent',
    async (drift) => {
      const input = authMailInput()
      const github = new ApplyGitHub()
      const state = new MemoryAuthMailState()
      await expect(
        rollbackPlatformRelease(
          {
            ...input,
            apply: true,
            confirmRollbackDigest: computeAuthMailRollbackDigest(input.plan, input.confirmContentDigest),
          },
          github,
          {
            authMail: {
              async preflight(context) {
                return suppressionEvidence(context)
              },
              async cutover() {
                throw new Error('must not run')
              },
              async rollback(context) {
                return {
                  suppression: suppressionEvidence(context),
                  authCommandsDisabled: true,
                  otherCommandsUnchanged: true,
                }
              },
              async verifyRollback(context) {
                return {
                  suppression: suppressionEvidence(context, drift !== 'suppression'),
                  authCommandsDisabled: drift !== 'auth-commands',
                  otherCommandsUnchanged: drift !== 'other-commands',
                  applicationShas: {
                    ...context.previousShas,
                    ...(drift === 'application-sha' ? { website: 'f'.repeat(40) } : {}),
                  },
                }
              },
            },
            authMailState: state,
            pollIntervalMs: 0,
            timeoutMs: 100,
          },
        ),
      ).rejects.toMatchObject({ state: 'rollback-required' })
      expect(state.progress).toEqual({ rollback: true, state: 'rollback-required' })
      expect(github.dispatches).toHaveLength(2)
      expect(github.releases).toEqual([])
    },
  )

  it('deploys no rollback target when Auth command disablement cannot be verified', async () => {
    const input = authMailInput()
    const github = new ApplyGitHub()
    const state = new MemoryAuthMailState()
    await expect(
      rollbackPlatformRelease(
        {
          ...input,
          apply: true,
          confirmRollbackDigest: computeAuthMailRollbackDigest(input.plan, input.confirmContentDigest),
        },
        github,
        {
          authMail: {
            async preflight(context) {
              return suppressionEvidence(context)
            },
            async cutover() {
              throw new Error('must not run')
            },
            async rollback(context) {
              return {
                suppression: suppressionEvidence(context),
                authCommandsDisabled: false,
                otherCommandsUnchanged: true,
              }
            },
            async verifyRollback() {
              throw new Error('must not run')
            },
          },
          authMailState: state,
          pollIntervalMs: 0,
          timeoutMs: 100,
        },
      ),
    ).rejects.toMatchObject({ state: 'rollback-required' })
    expect(state.progress?.rollback).toBe(true)
    expect(github.dispatches).toEqual([])
  })

  it('resumes interrupted explicit rollback without repeating the successful previous-SHA deployment', async () => {
    const input = authMailInput()
    const github = new ApplyGitHub()
    github.failureRepository = input.plan.repositories.website.repository
    const state = new MemoryAuthMailState()
    let disablements = 0
    const options = {
      authMail: {
        async preflight(context: AuthMailContext) {
          return suppressionEvidence(context)
        },
        async cutover() {
          throw new Error('must not run')
        },
        async rollback(context: AuthMailContext) {
          disablements += 1
          return { suppression: suppressionEvidence(context), authCommandsDisabled: true, otherCommandsUnchanged: true }
        },
        async verifyRollback(context: AuthMailContext) {
          return {
            suppression: suppressionEvidence(context),
            authCommandsDisabled: true,
            otherCommandsUnchanged: true,
            applicationShas: context.previousShas,
          }
        },
      },
      authMailState: state,
      pollIntervalMs: 0,
      timeoutMs: 100,
    }
    const rollbackInput = {
      ...input,
      apply: true,
      confirmRollbackDigest: computeAuthMailRollbackDigest(input.plan, input.confirmContentDigest),
    }
    await expect(rollbackPlatformRelease(rollbackInput, github, options)).rejects.toMatchObject({
      state: 'rollback-required',
    })
    expect(state.progress?.rollback).toBe(true)
    github.failureRepository = undefined
    expect((await rollbackPlatformRelease(rollbackInput, github, options)).status).toBe('rolled-back')
    expect(disablements).toBe(2)
    expect(github.dispatches).toEqual([
      input.plan.repositories.dashboard.repository,
      input.plan.repositories.website.repository,
      input.plan.repositories.website.repository,
    ])
    expect([...github.workflowRuns.values()].map(({ displayTitle }) => displayTitle.split(' · ').at(-1))).toEqual([
      'b'.repeat(40),
      'c'.repeat(40),
    ])
    expect(github.releases).toEqual([])
  })

  it('fails closed when a bound Auth mail plan has no protected Website adapter', async () => {
    const github = new ApplyGitHub()
    await expect(
      applyPlatformRelease(authMailInput(), github, new FounderOps(github.events), announcementStore, {
        pollIntervalMs: 0,
        timeoutMs: 100,
      }),
    ).rejects.toThrow('protected Website Auth mail adapter is unavailable')
    expect(github.dispatches).toEqual([])
    expect(github.releases).toEqual([])
  })

  it('starts both deployments only after cutover readback and fresh preflights', async () => {
    const github = new ApplyGitHub()
    let enabled = false
    const adapter = {
      async preflight(context: AuthMailContext) {
        github.events.push('preflight')
        return suppressionEvidence(context, enabled)
      },
      async cutover(context: AuthMailContext) {
        github.events.push('cutover')
        enabled = true
        return suppressionEvidence(context)
      },
    }
    const result = await applyPlatformRelease(
      authMailInput(),
      github,
      new FounderOps(github.events),
      announcementStore,
      { authMail: adapter, authMailState: new MemoryAuthMailState(), pollIntervalMs: 0, timeoutMs: 100 },
    )
    expect(github.events.slice(0, 7)).toEqual([
      'preflight',
      'cutover',
      'preflight',
      'preflight',
      'deploy:findmydoc-platform/clinic-dashboard',
      'preflight',
      'deploy:findmydoc-platform/website',
    ])
    expect(result.status).toBe('published')
  })

  it.each(['findmydoc-platform/clinic-dashboard', 'findmydoc-platform/website'])(
    'resumes a failure during %s without another cutover',
    async (repository) => {
      const github = new ApplyGitHub()
      github.failureRepository = repository
      let enabled = false
      let cutovers = 0
      const adapter = {
        async preflight(context: AuthMailContext) {
          return suppressionEvidence(context, enabled)
        },
        async cutover(context: AuthMailContext) {
          cutovers += 1
          enabled = true
          return suppressionEvidence(context)
        },
      }
      const state = new MemoryAuthMailState()
      const options = { authMail: adapter, authMailState: state, pollIntervalMs: 0, timeoutMs: 100 }
      await expect(
        applyPlatformRelease(authMailInput(), github, new FounderOps(github.events), announcementStore, options),
      ).rejects.toMatchObject({ state: 'rollback-required' })
      expect(github.releases).toEqual([])
      expect(enabled).toBe(true)
      github.failureRepository = undefined
      await applyPlatformRelease(authMailInput(), github, new FounderOps(github.events), announcementStore, options)
      expect(cutovers).toBe(1)
      expect(state.progress).toEqual({ rollback: false, state: 'published' })
    },
  )

  it('stops a resumed post-cutover release when fresh preflight detects SMTP drift', async () => {
    const github = new ApplyGitHub()
    const state = new MemoryAuthMailState()
    state.progress = { rollback: false, state: 'cutover-applied' }
    await expect(
      applyPlatformRelease(authMailInput(), github, new FounderOps(github.events), announcementStore, {
        authMail: {
          async preflight(context) {
            return { ...suppressionEvidence(context), customSmtpConfigured: true }
          },
          async cutover() {
            throw new Error('must not run')
          },
        },
        authMailState: state,
        pollIntervalMs: 0,
        timeoutMs: 100,
      }),
    ).rejects.toMatchObject({ state: 'rollback-required' })
    expect(github.dispatches).toEqual([])
    expect(state.progress?.state).toBe('rollback-required')
  })

  it('creates no draft when suppression readback drifts after both deployments', async () => {
    const github = new ApplyGitHub()
    let preflights = 0
    const state = new MemoryAuthMailState()
    await expect(
      applyPlatformRelease(authMailInput(), github, new FounderOps(github.events), announcementStore, {
        authMail: {
          async preflight(context) {
            preflights += 1
            return {
              ...suppressionEvidence(context),
              permissionVerified: preflights < 4,
            }
          },
          async cutover() {
            throw new Error('must not run')
          },
        },
        authMailState: state,
        pollIntervalMs: 0,
        timeoutMs: 100,
      }),
    ).rejects.toMatchObject({ state: 'rollback-required' })
    expect(github.dispatches).toHaveLength(2)
    expect(github.releases).toEqual([])
  })

  it('rejects rollback of a published immutable version before command or application changes', async () => {
    const input = authMailInput()
    const github = new ApplyGitHub()
    github.releaseDetails.set(input.plan.repositories.website.repository, {
      body: '',
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
      rollbackPlatformRelease(
        {
          ...input,
          apply: true,
          confirmRollbackDigest: computeAuthMailRollbackDigest(input.plan, input.confirmContentDigest),
        },
        github,
        {
          authMail: {
            async preflight() {
              throw new Error('must not run')
            },
            async cutover() {
              throw new Error('must not run')
            },
            async rollback() {
              throw new Error('must not run')
            },
            async verifyRollback() {
              throw new Error('must not run')
            },
          },
          authMailState: new MemoryAuthMailState(),
        },
      ),
    ).rejects.toThrow('published version cannot be rolled back')
    expect(github.dispatches).toEqual([])
  })

  it('never redeploys a bound version with an already published immutable component', async () => {
    const input = authMailInput()
    const github = new ApplyGitHub()
    github.releaseDetails.set(input.plan.repositories.website.repository, {
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
      applyPlatformRelease(input, github, new FounderOps(github.events), announcementStore, {
        authMail: {
          async preflight(context) {
            return suppressionEvidence(context)
          },
          async cutover() {
            throw new Error('must not run')
          },
        },
        authMailState: new MemoryAuthMailState(),
        pollIntervalMs: 0,
        timeoutMs: 100,
      }),
    ).rejects.toThrow()
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
    const result = await applyPlatformRelease(applyInput(), github, founderOps, announcementStore, {
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
      applyPlatformRelease(applyInput(), github, new FounderOps(github.events), announcementStore, {
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
      applyPlatformRelease(applyInput(untrustedPlan), github, new FounderOps(github.events), announcementStore),
    ).rejects.toThrow('does not match the trusted platform release configuration')
    expect(github.dispatches).toEqual([])
  })

  it('resumes after the first GitHub release without recreating it', async () => {
    const github = new ApplyGitHub()
    github.createFailureRepository = 'findmydoc-platform/website'
    await expect(
      applyPlatformRelease(applyInput(), github, new FounderOps(github.events), announcementStore, {
        pollIntervalMs: 0,
        timeoutMs: 100,
      }),
    ).rejects.toThrow('release creation failed')
    expect(github.releases).toEqual(['findmydoc-platform/clinic-dashboard'])

    github.createFailureRepository = undefined
    await applyPlatformRelease(applyInput(), github, new FounderOps(github.events), announcementStore, {
      pollIntervalMs: 0,
      timeoutMs: 100,
    })
    expect(github.releases).toEqual(['findmydoc-platform/clinic-dashboard', 'findmydoc-platform/website'])
  })

  it('resumes after a manifest upload failure without recreating releases', async () => {
    const github = new ApplyGitHub()
    github.manifestFailureRepository = 'findmydoc-platform/website'
    await expect(
      applyPlatformRelease(applyInput(), github, new FounderOps(github.events), announcementStore, {
        pollIntervalMs: 0,
        timeoutMs: 100,
      }),
    ).rejects.toThrow('manifest upload failed')
    expect(github.releases).toHaveLength(2)
    expect(github.events.filter((event) => event.startsWith('publish:'))).toEqual([])

    github.manifestFailureRepository = undefined
    await applyPlatformRelease(applyInput(), github, new FounderOps(github.events), announcementStore, {
      pollIntervalMs: 0,
      timeoutMs: 100,
    })
    expect(github.releases).toHaveLength(2)
  })

  it('resumes a partial publication with the same manifest', async () => {
    const github = new ApplyGitHub()
    github.publishFailureRepository = 'findmydoc-platform/website'
    await expect(
      applyPlatformRelease(applyInput(), github, new FounderOps(github.events), announcementStore, {
        pollIntervalMs: 0,
        timeoutMs: 100,
      }),
    ).rejects.toThrow('release publication failed')
    const firstManifest = github.manifests[0]
    expect(github.releaseDetails.get('findmydoc-platform/clinic-dashboard')?.draft).toBe(false)
    expect(github.releaseDetails.get('findmydoc-platform/website')?.draft).toBe(true)

    github.publishFailureRepository = undefined
    await applyPlatformRelease(applyInput(), github, new FounderOps(github.events), announcementStore, {
      pollIntervalMs: 0,
      timeoutMs: 100,
    })
    expect(github.lastManifestAttempt).toBe(firstManifest)
    expect([...github.releaseDetails.values()].every((release) => release.draft === false)).toBe(true)
  })

  it('fails closed when a published immutable release is missing its manifest', async () => {
    const github = new ApplyGitHub()
    await applyPlatformRelease(applyInput(), github, new FounderOps(github.events), announcementStore, {
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
      applyPlatformRelease(applyInput(), github, new FounderOps(github.events), announcementStore, {
        pollIntervalMs: 0,
        timeoutMs: 100,
      }),
    ).rejects.toThrow('immutable and missing platform-release.json')
  })

  it('heals the live partial state with only the website manifest present', async () => {
    const github = new ApplyGitHub()
    github.manifestFailureRepository = 'findmydoc-platform/clinic-dashboard'
    await expect(
      applyPlatformRelease(applyInput(), github, new FounderOps(github.events), announcementStore, {
        pollIntervalMs: 0,
        timeoutMs: 100,
      }),
    ).rejects.toThrow('manifest upload failed')
    expect(github.lastManifestAttempt).toBeDefined()

    github.manifestByRepository.set('findmydoc-platform/website', github.lastManifestAttempt ?? '')
    github.manifestFailureRepository = undefined
    await applyPlatformRelease(applyInput(), github, new FounderOps(github.events), announcementStore, {
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
      applyPlatformRelease(applyInput(), github, new FounderOps(github.events, true), announcementStore, {
        pollIntervalMs: 0,
        timeoutMs: 100,
      }),
    ).rejects.toThrow('FounderOps failed')
    const firstManifest = github.manifests[0]
    const replay = new FounderOps(github.events)
    await applyPlatformRelease(applyInput(), github, replay, announcementStore, { pollIntervalMs: 0, timeoutMs: 100 })
    expect(github.releases).toHaveLength(2)
    expect(github.manifests.every((manifest) => manifest === firstManifest)).toBe(true)
    expect(replay.calls).toBe(1)
  })
})
