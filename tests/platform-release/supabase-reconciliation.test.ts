import { describe, expect, it } from 'vitest'
import {
  bindSupabaseRelease,
  reconcileSupabaseRelease,
  supabaseReleaseContext,
} from '../../src/platform-release/supabase-reconciliation.js'
import { opsFixture, rehash } from './supabase-fixture.js'
import { canonicalJson, sha256 } from '../../src/platform-release/canonical.js'
import type {
  PlatformReleaseGitHubClient,
  PlatformReleasePlan,
  SupabaseReleaseBinding,
  SupabaseReleaseContext,
  SupabaseReleaseRunStore,
  WorkflowArtifactBundle,
  WorkflowRun,
} from '../../src/platform-release/types.js'

const config = { repository: 'findmydoc-platform/ops', branch: 'main', workflow: 'supabase-auth-config.yml' }
const opsSha = 'f3deafd54970e4fad48a1e59cc24e39e0b4c8b3f'
const mailFields = [
  'mailer_subjects_invite',
  'mailer_templates_invite_content',
  'mailer_subjects_recovery',
  'mailer_templates_recovery_content',
]
const managedFields = [
  'hook_send_email_enabled',
  'hook_send_email_uri',
  'mailer_subjects_invite',
  'mailer_subjects_recovery',
  'mailer_templates_invite_content',
  'mailer_templates_recovery_content',
  'site_url',
  'uri_allow_list',
]
const workflow = 'name: Supabase Auth Config\n'
const binding: SupabaseReleaseBinding = {
  ...config,
  schemaVersion: 1,
  opsSha,
  workflowDigest: sha256(workflow),
  targets: {
    preview: {
      instance: 'staging',
      profile: 'shared-auth-mail',
      projectRefDigest: sha256('s'.repeat(20)),
      managedFields,
    },
    production: {
      instance: 'production',
      profile: 'shared-auth-mail',
      projectRefDigest: sha256('p'.repeat(20)),
      managedFields,
    },
  },
}
const frozenPlan = { supabaseReconciliation: binding, digest: 'd'.repeat(64), version: 'v1.2.3' } as PlatformReleasePlan
const contentDigest = 'c'.repeat(64)

class RunStore implements SupabaseReleaseRunStore {
  ids = new Map<string, number | null>()
  async getRun(context: SupabaseReleaseContext) {
    return this.ids.get(context.environment)
  }
  async begin(context: SupabaseReleaseContext) {
    this.ids.set(context.environment, null)
  }
  async recordRun(context: SupabaseReleaseContext, id: number) {
    this.ids.set(context.environment, id)
  }
}

function artifact(context: SupabaseReleaseContext, run: WorkflowRun): WorkflowArtifactBundle {
  const result = {
    schemaVersion: 1,
    release: context,
    sourceSha: opsSha,
    status: 'applied',
    results: [
      {
        instance: context.environment === 'preview' ? 'staging' : 'production',
        profile: 'shared-auth-mail',
        projectRef: (context.environment === 'preview' ? 's' : 'p').repeat(20),
        status: 'applied',
        suppression: { functionMatches: true, permissionsMatch: true, status: 'converged' },
        fields: managedFields.map((field) => ({
          field,
          status: 'converged',
          desired: { length: 10, sha256: 'a'.repeat(64) },
          remote: { length: 10, sha256: 'a'.repeat(64) },
        })),
      },
    ],
  }
  const files: Record<string, string> = {
    'operator-result.json': JSON.stringify(result),
    'release-context.json': JSON.stringify(context),
    'github-run.json': JSON.stringify({
      eventName: 'workflow_dispatch',
      operation: 'apply',
      operatorResultStatus: 'present',
      opsRef: 'main',
      opsSha,
      repository: config.repository,
      runAttempt: String(run.runAttempt),
      runId: String(run.databaseId),
      release: context,
      instanceId: result.results[0].instance,
      workflow: 'Supabase Auth Config',
      job: 'reconcile',
    }),
  }
  files['checksums.txt'] =
    Object.entries(files)
      .map(([name, value]) => `${sha256(value)}  ${name}`)
      .join('\n') + '\n'
  return {
    id: run.databaseId + 100,
    name: `supabase-auth-config-${run.databaseId}-${run.runAttempt}`,
    digest: `sha256:${'e'.repeat(64)}`,
    files,
  }
}

function reconciliationFixture() {
  const events: string[] = []
  const contexts = new Map<number, SupabaseReleaseContext>()
  const runs = new Map<number, WorkflowRun>()
  const store = new RunStore()
  const github = {
    async getBranchSha() {
      return opsSha
    },
    async isAncestor() {
      return true
    },
    async getRepositoryFile() {
      return workflow
    },
    async dispatchWorkflowRun(input: { inputs: Record<string, string> }) {
      expect(input.inputs.operation).toBe('apply')
      expect(input.inputs.apply_changes).toBe('true')
      const context = JSON.parse(input.inputs.release_context)
      expect(store.ids.get(context.environment)).toBe(null)
      const id = runs.size + 1
      const run = {
        databaseId: id,
        runAttempt: 1,
        event: 'workflow_dispatch',
        headBranch: 'main',
        headSha: opsSha,
        path: '.github/workflows/supabase-auth-config.yml',
        displayTitle: `Supabase Auth Config release apply ${id}`,
        status: 'completed',
        conclusion: 'success',
        url: `https://github.com/${config.repository}/actions/runs/${id}`,
      }
      contexts.set(id, context)
      runs.set(id, run)
      events.push(`dispatch:${context.environment}`)
      return run
    },
    async getWorkflowRun(_repository: string, id: number) {
      return runs.get(id)!
    },
    async getWorkflowArtifact(_repository: string, run: WorkflowRun) {
      const context = contexts.get(run.databaseId)!
      events.push(`verified:${context.environment}`)
      return artifact(context, run)
    },
  } as unknown as PlatformReleaseGitHubClient
  return { github, store, events, contexts, runs }
}

describe('Ops-owned Supabase release reconciliation', () => {
  it('rejects a different execution SHA even when workflow bytes and frozen reconciliation outcomes match', async () => {
    const fixture = opsFixture()
    const read = fixture.client.getWorkflowRun
    const github = {
      ...fixture.client,
      async isAncestor() {
        return true
      },
      async getWorkflowRun(repository: string, id: number) {
        return { ...(await read(repository, id)), headSha: 'a'.repeat(40) }
      },
    } as unknown as PlatformReleaseGitHubClient
    await expect(reconcileSupabaseRelease(frozenPlan, contentDigest, github, fixture.store)).rejects.toThrow(
      'Ops preview',
    )
    expect(fixture.runs.size).toBe(1)
    expect(fixture.events).toEqual(['dispatch:preview'])
  })
  it.each(['preview', 'production'])('checks current main before a new %s intent and dispatch', async (environment) => {
    const fixture = opsFixture()
    const advancedSha = 'a'.repeat(40)
    const github = {
      ...fixture.client,
      async isAncestor() {
        return true
      },
      async getBranchSha() {
        return environment === 'preview' || fixture.events.includes('verified:preview') ? advancedSha : opsSha
      },
      async getRepositoryFile(_repository: string, _path: string, sha: string) {
        return sha === advancedSha ? 'changed privileged workflow\n' : workflow
      },
    } as unknown as PlatformReleaseGitHubClient
    await expect(reconcileSupabaseRelease(frozenPlan, contentDigest, github, fixture.store)).rejects.toThrow(
      `Ops ${environment}`,
    )
    expect(fixture.runs.size).toBe(environment === 'preview' ? 0 : 1)
    expect(fixture.store.ids.size).toBe(environment === 'preview' ? 0 : 1)
  })
  it('times out a recorded running invocation without dispatching a replacement on resume', async () => {
    const fixture = opsFixture()
    const read = fixture.client.getWorkflowRun
    const github = {
      ...fixture.client,
      async isAncestor() {
        return true
      },
      async getWorkflowRun(repository: string, id: number) {
        return { ...(await read(repository, id)), status: 'in_progress', conclusion: null }
      },
    } as unknown as PlatformReleaseGitHubClient
    await expect(
      reconcileSupabaseRelease(frozenPlan, contentDigest, github, fixture.store, { timeoutMs: 0 }),
    ).rejects.toThrow('Ops preview')
    expect(fixture.runs.size).toBe(1)
    github.getWorkflowRun = read
    await reconcileSupabaseRelease(frozenPlan, contentDigest, github, fixture.store)
    expect(fixture.runs.size).toBe(2)
  })
  it.each([
    'dry_run',
    'source',
    'content',
    'environment',
    'profile',
    'project',
    'missing_field',
    'extra_field',
    'duplicate_field',
    'drift',
    'fingerprint',
    'suppression',
    'checksum',
    'attempt',
    'raw_value',
  ])('rejects %s evidence before Production dispatch', async (kind) => {
    const fixture = opsFixture()
    const read = fixture.client.getWorkflowArtifact
    fixture.client.getWorkflowArtifact = async (repository, run) => {
      const bundle = await read(repository, run)
      const result = JSON.parse(bundle.files['operator-result.json']!)
      const instance = result.results[0]
      if (kind === 'dry_run') result.status = instance.status = 'dry_run'
      if (kind === 'source') result.sourceSha = '0'.repeat(40)
      if (kind === 'content') result.release.contentDigest = '0'.repeat(64)
      if (kind === 'environment') instance.instance = 'production'
      if (kind === 'profile') instance.profile = 'unowned-profile'
      if (kind === 'project') instance.projectRef = 'x'.repeat(20)
      if (kind === 'missing_field') instance.fields.pop()
      if (kind === 'extra_field') instance.fields.push({ ...instance.fields[0], field: 'smtp_pass' })
      if (kind === 'duplicate_field') instance.fields[1] = instance.fields[0]
      if (kind === 'drift') instance.fields[0].status = 'drift'
      if (kind === 'fingerprint') instance.fields[0].remote.sha256 = '0'.repeat(64)
      if (kind === 'suppression') instance.suppression.permissionsMatch = false
      if (kind === 'raw_value') instance.fields[0].raw = 'must-not-leak'
      bundle.files['operator-result.json'] = JSON.stringify(result)
      rehash(bundle.files)
      if (kind === 'checksum') bundle.files['operator-result.json'] += ' '
      if (kind === 'attempt') bundle.name = 'supabase-auth-config-1-99'
      return bundle
    }
    const github = {
      ...fixture.client,
      async isAncestor() {
        return true
      },
    } as unknown as PlatformReleaseGitHubClient
    await expect(reconcileSupabaseRelease(frozenPlan, contentDigest, github, fixture.store)).rejects.toThrow(
      'Ops preview reconciliation could not be verified',
    )
    expect(fixture.runs.size).toBe(1)
  })

  it('never retries an ambiguous intent or invents evidence for an already published release', async () => {
    const fixture = opsFixture()
    const github = {
      ...fixture.client,
      async isAncestor() {
        return true
      },
    } as unknown as PlatformReleaseGitHubClient
    await expect(
      reconcileSupabaseRelease(frozenPlan, contentDigest, github, fixture.store, { allowDispatch: false }),
    ).rejects.toThrow('Ops preview')
    await fixture.store.begin(supabaseReleaseContext(frozenPlan, contentDigest, 'preview'))
    await expect(reconcileSupabaseRelease(frozenPlan, contentDigest, github, fixture.store)).rejects.toThrow(
      'Ops preview',
    )
    expect(fixture.runs.size).toBe(0)
  })

  it('preserves both exact IDs on Production failure and resumes a rerun with a new attempt', async () => {
    const fixture = opsFixture()
    const getRun = fixture.client.getWorkflowRun
    let failure = true
    fixture.client.getWorkflowRun = async (repository, id) => ({
      ...(await getRun(repository, id)),
      ...(id === 2 && failure ? { conclusion: 'failure' } : {}),
    })
    const github = {
      ...fixture.client,
      async isAncestor() {
        return true
      },
    } as unknown as PlatformReleaseGitHubClient
    await expect(reconcileSupabaseRelease(frozenPlan, contentDigest, github, fixture.store)).rejects.toThrow(
      'Ops production',
    )
    expect(fixture.runs.size).toBe(2)
    failure = false
    fixture.runs.get(2)!.runAttempt = 2
    const result = await reconcileSupabaseRelease(frozenPlan, contentDigest, github, fixture.store)
    expect(result.environments.production).toMatchObject({ runId: 2, runAttempt: 2 })
    expect(fixture.runs.size).toBe(2)
  })

  it('records the dispatch receipt before a subsequent read failure and never dispatches a replacement', async () => {
    const fixture = opsFixture()
    const getRun = fixture.client.getWorkflowRun
    const github = {
      ...fixture.client,
      async isAncestor() {
        return true
      },
      async getWorkflowRun() {
        throw new Error('temporary API failure')
      },
    } as unknown as PlatformReleaseGitHubClient
    await expect(reconcileSupabaseRelease(frozenPlan, contentDigest, github, fixture.store)).rejects.toThrow(
      'Ops preview',
    )
    expect(await fixture.store.getRun(supabaseReleaseContext(frozenPlan, contentDigest, 'preview'))).toBe(1)
    github.getWorkflowRun = getRun
    await reconcileSupabaseRelease(frozenPlan, contentDigest, github, fixture.store)
    expect(fixture.runs.size).toBe(2)
  })

  it.each(['headBranch', 'headSha', 'path', 'displayTitle', 'url'])(
    'rejects unrelated %s run metadata before reading its audit',
    async (field) => {
      const fixture = opsFixture()
      const getRun = fixture.client.getWorkflowRun
      const github = {
        ...fixture.client,
        async isAncestor() {
          return true
        },
        async getWorkflowRun(repository: string, id: number) {
          return { ...(await getRun(repository, id)), [field]: 'untrusted' }
        },
      } as unknown as PlatformReleaseGitHubClient
      await expect(reconcileSupabaseRelease(frozenPlan, contentDigest, github, fixture.store)).rejects.toThrow(
        'Ops preview',
      )
      expect(fixture.events).toEqual(['dispatch:preview'])
    },
  )
  it('verifies Preview before Production, records exact runs, and resumes without dispatching again', async () => {
    const fixture = reconciliationFixture()
    const result = await reconcileSupabaseRelease(frozenPlan, contentDigest, fixture.github, fixture.store, {
      pollIntervalMs: 0,
      timeoutMs: 100,
    })
    expect(fixture.events).toEqual([
      'dispatch:preview',
      'verified:preview',
      'dispatch:production',
      'verified:production',
    ])
    expect(result.environments.production.status).toBe('verified')
    fixture.events.length = 0
    expect(
      await reconcileSupabaseRelease(frozenPlan, contentDigest, fixture.github, fixture.store, {
        pollIntervalMs: 0,
        timeoutMs: 100,
      }),
    ).toEqual(result)
    expect(fixture.events).toEqual(['verified:preview', 'verified:production'])
    expect(JSON.stringify(result)).not.toContain('projectRef')
  })
  it('binds the complete opted-in inventory to one frozen trusted Ops commit without raw configuration', async () => {
    const reads: string[] = []
    const github = {
      async getBranchSha() {
        return opsSha
      },
      async getRepositoryFile(_repository: string, path: string, sha: string) {
        expect(sha).toBe(opsSha)
        reads.push(path)
        if (path.startsWith('.github/')) return 'name: Supabase Auth Config\n'
        if (path.includes('/profiles/'))
          return JSON.stringify({ version: 1, id: 'shared-auth-mail', managedFields: mailFields })
        const production = path.endsWith('production.json')
        return JSON.stringify({
          version: 1,
          id: production ? 'production' : 'staging',
          profileId: 'shared-auth-mail',
          projectRef: (production ? 'p' : 's').repeat(20),
          credentialId: 'findmydoc',
          applyProtection: production ? 'protected' : 'standard',
          authRouting: {},
          nativeMailSuppression: true,
        })
      },
    } as unknown as PlatformReleaseGitHubClient
    const binding = await bindSupabaseRelease(config, github)
    expect(binding.opsSha).toBe(opsSha)
    expect(binding.targets.preview.instance).toBe('staging')
    expect(binding.targets.production.managedFields).toEqual([
      'hook_send_email_enabled',
      'hook_send_email_uri',
      'mailer_subjects_invite',
      'mailer_subjects_recovery',
      'mailer_templates_invite_content',
      'mailer_templates_recovery_content',
      'site_url',
      'uri_allow_list',
    ])
    expect(reads).toHaveLength(5)
    expect(JSON.stringify(binding)).not.toContain('credentialId')
    expect(JSON.stringify(binding)).not.toContain('p'.repeat(20))
  })
})
