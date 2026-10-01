import { mkdtemp, lstat, readdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { canonicalJson, sha256 } from './canonical.js'
import type { SupabaseReleaseContext, SupabaseReleaseRunStore, WorkflowArtifactBundle, WorkflowRun } from './types.js'

export type SupabaseGitHubRequest = <T>(
  path: string,
  options?: { method?: string; body?: unknown; apiVersion?: string },
) => Promise<T>
type GitHubCommand = (args: string[]) => Promise<string>
type Run = {
  id: number
  run_attempt: number
  event: string
  head_branch: string
  head_sha: string
  path: string
  display_title: string
  status: string
  conclusion: string | null
  html_url: string
}

export class GitHubSupabaseOperations {
  constructor(
    private readonly request: SupabaseGitHubRequest,
    private readonly command: GitHubCommand,
  ) {}

  async getRepositoryFile(repository: string, path: string, sha: string): Promise<string | undefined> {
    if (!/^[a-f0-9]{40}$/.test(sha)) throw new Error('Ops source requires an immutable SHA.')
    const result = await this.request<{ type: string; encoding: string; content: string; size: number }>(
      `repos/${repository}/contents/${path}?ref=${sha}`,
    )
    if (result.type !== 'file' || result.encoding !== 'base64' || result.size > 1_048_576)
      throw new Error('Ops source file is unavailable.')
    return Buffer.from(result.content, 'base64').toString('utf8')
  }

  async dispatchWorkflowRun(input: {
    repository: string
    branch: string
    workflow: string
    inputs: Record<string, string>
  }): Promise<Pick<WorkflowRun, 'databaseId' | 'url'>> {
    const result = await this.request<{ workflow_run_id: number; run_url: string; html_url: string }>(
      `repos/${input.repository}/actions/workflows/${encodeURIComponent(input.workflow)}/dispatches`,
      {
        method: 'POST',
        apiVersion: '2026-03-10',
        body: { ref: input.branch, inputs: input.inputs },
      },
    )
    if (
      !Number.isSafeInteger(result?.workflow_run_id) ||
      result.workflow_run_id <= 0 ||
      result.run_url !== `https://api.github.com/repos/${input.repository}/actions/runs/${result.workflow_run_id}` ||
      result.html_url !== `https://github.com/${input.repository}/actions/runs/${result.workflow_run_id}`
    )
      throw new Error('Ops dispatch did not return an unambiguous run identity.')
    return { databaseId: result.workflow_run_id, url: result.html_url }
  }

  async getWorkflowRun(repository: string, runId: number): Promise<WorkflowRun> {
    const run = await this.request<Run>(`repos/${repository}/actions/runs/${runId}`)
    return {
      databaseId: run.id,
      runAttempt: run.run_attempt,
      event: run.event,
      headBranch: run.head_branch,
      headSha: run.head_sha,
      path: run.path,
      displayTitle: run.display_title,
      status: run.status,
      conclusion: run.conclusion,
      url: run.html_url,
    }
  }

  async getWorkflowArtifact(repository: string, run: WorkflowRun, name: string): Promise<WorkflowArtifactBundle> {
    type Artifact = {
      id: number
      name: string
      digest: string
      expired: boolean
      workflow_run: { id: number; head_sha: string }
      size_in_bytes: number
    }
    const matches: Artifact[] = []
    for (let page = 1; page <= 100; page += 1) {
      const result = await this.request<{ artifacts: Artifact[] }>(
        `repos/${repository}/actions/runs/${run.databaseId}/artifacts?per_page=100&page=${page}`,
      )
      matches.push(...result.artifacts.filter((artifact) => artifact.name === name))
      if (result.artifacts.length < 100) break
      if (page === 100) throw new Error('Ops artifact inventory is incomplete.')
    }
    const artifact = matches[0]
    if (
      matches.length !== 1 ||
      !artifact ||
      artifact.expired ||
      artifact.workflow_run.id !== run.databaseId ||
      artifact.workflow_run.head_sha !== run.headSha ||
      artifact.size_in_bytes > 2_097_152
    )
      throw new Error('Ops artifact is missing, expired, or ambiguous.')
    const directory = await mkdtemp(join(tmpdir(), 'fmd-ops-result-'))
    try {
      await this.command([
        'run',
        'download',
        String(run.databaseId),
        '--repo',
        repository,
        '--name',
        name,
        '--dir',
        directory,
      ])
      const names = await readdir(directory)
      if (names.length > 50) throw new Error('Ops artifact contains too many files.')
      const files: Record<string, string> = {}
      for (const filename of names) {
        const path = join(directory, filename)
        const stat = await lstat(path)
        if (!/^[a-zA-Z0-9._-]+$/.test(filename) || !stat.isFile() || stat.isSymbolicLink() || stat.size > 1_048_576)
          throw new Error('Ops artifact file is invalid.')
        const bytes = await readFile(path)
        const value = bytes.toString('utf8')
        if (!Buffer.from(value, 'utf8').equals(bytes)) throw new Error('Ops artifact file is not UTF-8.')
        files[filename] = value
      }
      return { id: artifact.id, name: artifact.name, digest: artifact.digest, files }
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  }
}

type Deployment = { id: number; payload: unknown }
type JournalStatus = { state: string; description: string }
const same = (a: unknown, b: unknown) => canonicalJson(a) === canonicalJson(b)

export class GhSupabaseReleaseRunStore implements SupabaseReleaseRunStore {
  constructor(
    private readonly request: SupabaseGitHubRequest,
    private readonly repository = 'findmydoc-platform/platform-release',
    private readonly ref = 'main',
  ) {}

  private payload(context: SupabaseReleaseContext) {
    return { schemaVersion: 1, contextDigest: sha256(canonicalJson(context)), release: context }
  }
  private environment(context: SupabaseReleaseContext) {
    return `supabase-release-${context.environment}`
  }

  private async find(context: SupabaseReleaseContext): Promise<Deployment | undefined> {
    const matches: Deployment[] = []
    const expected = this.payload(context)
    for (let page = 1; page <= 1000; page += 1) {
      const deployments = await this.request<Deployment[]>(
        `repos/${this.repository}/deployments?environment=${this.environment(context)}&per_page=100&page=${page}`,
      )
      for (const deployment of deployments) {
        let payload = deployment.payload
        if (typeof payload === 'string') payload = JSON.parse(payload)
        if ((payload as { contextDigest?: unknown } | null)?.contextDigest !== expected.contextDigest) continue
        if (!same(payload, expected)) throw new Error('Ops invocation identity is conflicting.')
        matches.push(deployment)
      }
      if (deployments.length < 100) break
      if (page === 1000) throw new Error('Ops invocation inventory is incomplete.')
    }
    if (matches.length > 1) throw new Error('Ops invocation has duplicate intents.')
    return matches[0]
  }

  private async runId(deployment: Deployment): Promise<number | null> {
    let assigned: number | null = null
    for (let page = 1; page <= 100; page += 1) {
      const statuses = await this.request<JournalStatus[]>(
        `repos/${this.repository}/deployments/${deployment.id}/statuses?per_page=100&page=${page}`,
      )
      for (const status of statuses) {
        const record = JSON.parse(status.description) as { schemaVersion: number; runId: number | null }
        if (
          !same(Object.keys(record).sort(), ['runId', 'schemaVersion']) ||
          record.schemaVersion !== 1 ||
          status.state !== 'in_progress' ||
          (record.runId !== null && (!Number.isSafeInteger(record.runId) || record.runId <= 0)) ||
          (assigned !== null && record.runId !== null && assigned !== record.runId)
        )
          throw new Error('Ops invocation run mapping is conflicting.')
        assigned ??= record.runId
      }
      if (statuses.length < 100) return assigned
    }
    throw new Error('Ops invocation status history is incomplete.')
  }

  async getRun(context: SupabaseReleaseContext): Promise<number | null | undefined> {
    const deployment = await this.find(context)
    return deployment ? this.runId(deployment) : undefined
  }

  async begin(context: SupabaseReleaseContext): Promise<void> {
    if (await this.find(context)) throw new Error('Ops invocation intent already exists.')
    const created = await this.request<Deployment>(`repos/${this.repository}/deployments`, {
      method: 'POST',
      body: {
        ref: this.ref,
        auto_merge: false,
        required_contexts: [],
        environment: this.environment(context),
        production_environment: false,
        transient_environment: false,
        description: `Ops reconciliation invocation for ${context.version}`,
        payload: this.payload(context),
      },
    })
    if ((await this.find(context))?.id !== created.id) throw new Error('Ops invocation intent is ambiguous.')
    await this.write(created.id, null)
  }

  async recordRun(context: SupabaseReleaseContext, runId: number): Promise<void> {
    if (!Number.isSafeInteger(runId) || runId <= 0) throw new Error('Ops run ID is invalid.')
    const deployment = await this.find(context)
    if (!deployment) throw new Error('Ops invocation intent is unavailable.')
    const current = await this.runId(deployment)
    if (current === runId) return
    if (current !== null) throw new Error('Ops invocation run ID cannot be replaced.')
    await this.write(deployment.id, runId)
    if ((await this.getRun(context)) !== runId) throw new Error('Ops invocation mapping could not be verified.')
  }

  private async write(id: number, runId: number | null): Promise<void> {
    await this.request(`repos/${this.repository}/deployments/${id}/statuses`, {
      method: 'POST',
      body: {
        auto_inactive: false,
        state: 'in_progress',
        description: JSON.stringify({ schemaVersion: 1, runId }),
      },
    })
  }
}
