import { sha256 } from '../../src/platform-release/canonical.js'
import type {
  PlatformReleaseGitHubClient,
  SupabaseReleaseBinding,
  SupabaseReleaseContext,
  SupabaseReleaseRunStore,
  WorkflowArtifactBundle,
  WorkflowRun,
} from '../../src/platform-release/types.js'

export const opsConfig = { repository: 'findmydoc-platform/ops', branch: 'main', workflow: 'supabase-auth-config.yml' }
export const opsSha = 'f3deafd54970e4fad48a1e59cc24e39e0b4c8b3f'
export const opsWorkflow = 'name: Supabase Auth Config\n'
export const managedFields = [
  'hook_send_email_enabled',
  'hook_send_email_uri',
  'mailer_subjects_invite',
  'mailer_subjects_recovery',
  'mailer_templates_invite_content',
  'mailer_templates_recovery_content',
  'site_url',
  'uri_allow_list',
]
export const opsBinding: SupabaseReleaseBinding = {
  ...opsConfig,
  schemaVersion: 1,
  opsSha,
  workflowDigest: sha256(opsWorkflow),
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

export class TestRunStore implements SupabaseReleaseRunStore {
  ids = new Map<string, number | null>()
  async getRun(context: SupabaseReleaseContext) {
    return this.ids.get(JSON.stringify(context))
  }
  async begin(context: SupabaseReleaseContext) {
    this.ids.set(JSON.stringify(context), null)
  }
  async recordRun(context: SupabaseReleaseContext, id: number) {
    this.ids.set(JSON.stringify(context), id)
  }
}

export function opsArtifact(context: SupabaseReleaseContext, run: WorkflowRun): WorkflowArtifactBundle {
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
      repository: opsConfig.repository,
      runAttempt: String(run.runAttempt),
      runId: String(run.databaseId),
      release: context,
      instanceId: result.results[0]!.instance,
      workflow: 'Supabase Auth Config',
      job: 'reconcile',
    }),
  }
  rehash(files)
  return {
    id: run.databaseId + 100,
    name: `supabase-auth-config-${run.databaseId}-${run.runAttempt}`,
    digest: `sha256:${'e'.repeat(64)}`,
    files,
  }
}

export function rehash(files: Record<string, string>) {
  files['checksums.txt'] =
    Object.entries(files)
      .filter(([name]) => name !== 'checksums.txt')
      .map(([name, value]) => `${sha256(value)}  ${name}`)
      .join('\n') + '\n'
}

export function opsFixture(events: string[] = []) {
  const contexts = new Map<number, SupabaseReleaseContext>()
  const runs = new Map<number, WorkflowRun>()
  const store = new TestRunStore()
  const client = {
    async getBranchSha() {
      return opsSha
    },
    async getRepositoryFile() {
      return opsWorkflow
    },
    async dispatchWorkflowRun(input: { inputs: Record<string, string> }) {
      const context = JSON.parse(input.inputs.release_context!) as SupabaseReleaseContext
      if ((await store.getRun(context)) !== null) throw new Error('intent must precede dispatch')
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
        url: `https://github.com/${opsConfig.repository}/actions/runs/${id}`,
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
      return opsArtifact(context, run)
    },
  } satisfies Partial<PlatformReleaseGitHubClient>
  return { client, store, runs, contexts, events }
}
