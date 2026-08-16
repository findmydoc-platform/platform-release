import { spawn } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { bumpForMessage, compareVersions, parseVersion } from './semver.js'
import { extractReleaseVisuals } from './visuals.js'
import type {
  PlatformReleaseAnnouncementStore,
  PlatformReleaseGitHubClient,
  PlatformReleaseDetails,
  ReleaseAnnouncementState,
  ReleaseCommit,
  ReleaseIssue,
  ReleasePullRequest,
  WorkflowRun,
} from './types.js'

type GitHubRelease = {
  assets?: Array<{ id?: number; name?: string }>
  body?: string | null
  created_at?: string
  html_url?: string
  id?: number
  immutable?: boolean
  published_at?: string | null
  prerelease?: boolean
  draft?: boolean
  tag_name?: string
  target_commitish?: string
}

type GitHubWorkflowRun = {
  conclusion: string | null
  display_title: string
  html_url: string
  id: number
  status: string
}

type GitHubWorkflowRunsPage = {
  workflow_runs: GitHubWorkflowRun[]
}

type GitHubDeployment = {
  id: number
  payload?: unknown
}

type GitHubDeploymentStatus = {
  state?: string
}

type GitHubApiOptions = { method?: string; body?: unknown }
type GitHubApiRequest = <T>(path: string, options?: GitHubApiOptions) => Promise<T>

const WORKFLOW_RUNS_PAGE_SIZE = 100

export async function findWorkflowRunInPages(
  title: string,
  fetchPage: (page: number, perPage: number) => Promise<GitHubWorkflowRunsPage>,
): Promise<WorkflowRun | undefined> {
  for (let page = 1; ; page += 1) {
    const response = await fetchPage(page, WORKFLOW_RUNS_PAGE_SIZE)
    const run = response.workflow_runs.find((candidate) => candidate.display_title === title)
    if (run) {
      return {
        conclusion: run.conclusion,
        databaseId: run.id,
        displayTitle: run.display_title,
        status: run.status,
        url: run.html_url,
      }
    }
    if (response.workflow_runs.length < WORKFLOW_RUNS_PAGE_SIZE) return undefined
  }
}

class GhError extends Error {
  constructor(message: string, readonly stderr: string) {
    super(message)
  }
}

export function safeGhErrorDetail(error: unknown): string {
  const message = error instanceof GhError ? error.stderr : error instanceof Error ? error.message : String(error)
  return message
    .replace(/\bgh[a-z]_[A-Za-z0-9_]+\b/g, '[redacted]')
    .replace(/(authorization:\s*(?:bearer|token)\s+)\S+/gi, '$1[redacted]')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 1_000)
}

export function githubChildEnvironment(environment: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const allowlist = [
    'APPDATA',
    'COMSPEC',
    'GH_CONFIG_DIR',
    'GH_ENTERPRISE_TOKEN',
    'GH_HOST',
    'GH_TOKEN',
    'GITHUB_TOKEN',
    'HOME',
    'LANG',
    'LC_ALL',
    'LOCALAPPDATA',
    'PATH',
    'PATHEXT',
    'SystemRoot',
    'TEMP',
    'TMP',
    'USERPROFILE',
    'XDG_CONFIG_HOME',
  ] as const
  return Object.fromEntries(allowlist.flatMap((key) => environment[key] === undefined ? [] : [[key, environment[key]]]))
}

async function runGh(args: string[], input?: string, environment: NodeJS.ProcessEnv = process.env): Promise<string> {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn('gh', args, {
      env: githubChildEnvironment(environment),
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => { stdout += chunk })
    child.stderr.on('data', (chunk: string) => { stderr += chunk })
    child.on('error', (error) => rejectRun(new GhError(error.message, stderr)))
    child.on('close', (code) => {
      if (code === 0) resolveRun(stdout)
      else rejectRun(new GhError(`GitHub CLI exited with code ${code ?? 'unknown'}.`, stderr))
    })
    if (input === undefined) child.stdin.end()
    else child.stdin.end(input)
  })
}

async function api<T>(
  path: string,
  options: { method?: string; body?: unknown } = {},
  environment: NodeJS.ProcessEnv = process.env,
): Promise<T> {
  const args = ['api', path]
  if (options.method) args.push('--method', options.method)
  if (options.body !== undefined) args.push('--input', '-')
  const output = await runGh(args, options.body === undefined ? undefined : JSON.stringify(options.body), environment)
  return output.trim() ? JSON.parse(output) as T : undefined as T
}

async function optionalApi<T>(path: string): Promise<T | undefined> {
  try {
    return await api<T>(path)
  } catch (error) {
    if (error instanceof GhError && /HTTP 404|Not Found/i.test(error.stderr)) return undefined
    throw error
  }
}

async function resolveTagSha(repository: string, tag: string): Promise<string> {
  const ref = await api<{ object: { sha: string; type: string } }>(`repos/${repository}/git/ref/tags/${encodeURIComponent(tag)}`)
  if (ref.object.type !== 'tag') return ref.object.sha
  const annotated = await api<{ object: { sha: string } }>(`repos/${repository}/git/tags/${ref.object.sha}`)
  return annotated.object.sha
}

function releaseUrl(repository: string, version: string): string {
  return `https://github.com/${repository}/releases/tag/${encodeURIComponent(version)}`
}

async function findReleaseIncludingDraft(repository: string, version: string): Promise<GitHubRelease | undefined> {
  for (let page = 1; ; page += 1) {
    const releases = await api<GitHubRelease[]>(`repos/${repository}/releases?per_page=100&page=${page}`)
    const release = releases.find((candidate) => candidate.tag_name === version)
    if (release) return release
    if (releases.length < 100) return undefined
  }
}

async function platformReleaseDetails(
  repository: string,
  version: string,
  release: GitHubRelease,
): Promise<PlatformReleaseDetails> {
  if (!release.id || !release.created_at) {
    throw new Error(`GitHub did not return complete release metadata for ${repository} ${version}.`)
  }
  const draft = release.draft === true
  const sha = draft ? release.target_commitish : await resolveTagSha(repository, version)
  if (!sha) throw new Error(`GitHub draft ${repository} ${version} has no target commit.`)
  return {
    body: release.body ?? '',
    draft,
    id: release.id,
    immutable: release.immutable === true,
    preparedAt: release.created_at,
    publishedAt: release.published_at ?? undefined,
    sha,
    url: releaseUrl(repository, version),
  }
}

async function closingIssues(repository: string, number: number): Promise<ReleaseIssue[]> {
  const [owner, name] = repository.split('/')
  const query = `query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){pullRequest(number:$number){closingIssuesReferences(first:30){nodes{number title url repository{nameWithOwner}}}}}}`
  const output = await runGh([
    'api',
    'graphql',
    '--field',
    `query=${query}`,
    '--field',
    `owner=${owner ?? ''}`,
    '--field',
    `name=${name ?? ''}`,
    '--field',
    `number=${number}`,
  ])
  const parsed = JSON.parse(output) as {
    data?: { repository?: { pullRequest?: { closingIssuesReferences?: { nodes?: Array<{
      number: number
      repository: { nameWithOwner: string }
      title: string
      url: string
    }> } } } }
  }
  return (parsed.data?.repository?.pullRequest?.closingIssuesReferences?.nodes ?? []).map((issue) => ({
    number: issue.number,
    repository: issue.repository.nameWithOwner,
    title: issue.title,
    url: issue.url,
  }))
}

function compactPullRequestBody(markdown: string): string {
  const wanted = new Set(['management summary', 'what changed'])
  const sections: string[] = []
  const lines = markdown.replace(/<!--[\s\S]*?-->/g, '').split('\n')
  let active: { level: number; lines: string[] } | undefined

  const flush = () => {
    if (!active) return
    sections.push(active.lines.join('\n').trim())
    active = undefined
  }

  for (const line of lines) {
    const match = line.match(/^(#{1,6})\s+(.+)$/)
    if (match) {
      const level = match[1]?.length ?? 0
      const title = (match[2] ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()
      if (active && level <= active.level) flush()
      if (!active && wanted.has(title)) active = { level, lines: [line] }
      else active?.lines.push(line)
      continue
    }
    active?.lines.push(line)
  }
  flush()
  const compact = sections.filter(Boolean).join('\n\n') || markdown
  return compact.slice(0, 8_000)
}

export class GhPlatformReleaseClient implements PlatformReleaseGitHubClient {
  async getBranchSha(repository: string, branch: string): Promise<string> {
    const commit = await api<{ sha: string }>(`repos/${repository}/commits/${encodeURIComponent(branch)}`)
    return commit.sha
  }

  async getLatestRelease(repository: string): Promise<{ sha: string; version: string } | undefined> {
    const releases = await api<GitHubRelease[]>(`repos/${repository}/releases?per_page=50`)
    const eligible = releases
      .filter((release) => !release.draft && !release.prerelease && release.tag_name)
      .filter((release) => {
        try {
          parseVersion(release.tag_name ?? '')
          return true
        } catch {
          return false
        }
      })
      .sort((left, right) => compareVersions(right.tag_name ?? '', left.tag_name ?? ''))
    const version = eligible[0]?.tag_name
    if (!version) return undefined
    return { sha: await resolveTagSha(repository, version), version }
  }

  async compareCommits(repository: string, base: string, head: string): Promise<ReleaseCommit[]> {
    const comparison = await api<{
      commits: Array<{ commit: { message: string }; html_url: string; sha: string }>
      total_commits: number
    }>(`repos/${repository}/compare/${encodeURIComponent(base)}...${encodeURIComponent(head)}`)
    if (comparison.total_commits > comparison.commits.length) {
      throw new Error(`${repository} has ${comparison.total_commits} commits in the release range, exceeding the GitHub comparison response.`)
    }
    return comparison.commits.map((commit) => ({
      bump: bumpForMessage(commit.commit.message),
      message: commit.commit.message,
      sha: commit.sha,
      url: commit.html_url,
    }))
  }

  async getPullRequests(repository: string, commits: ReleaseCommit[]): Promise<ReleasePullRequest[]> {
    const commitsByPullRequest = new Map<number, Set<string>>()
    for (const commit of commits) {
      const pulls = await api<Array<{ number: number }>>(`repos/${repository}/commits/${commit.sha}/pulls`)
      for (const pull of pulls) {
        const shas = commitsByPullRequest.get(pull.number) ?? new Set<string>()
        shas.add(commit.sha)
        commitsByPullRequest.set(pull.number, shas)
      }
    }

    const pullRequests: ReleasePullRequest[] = []
    for (const number of [...commitsByPullRequest.keys()].sort((left, right) => left - right)) {
      const pull = await api<{ body: string | null; html_url: string; merged_at: string | null; number: number; title: string }>(
        `repos/${repository}/pulls/${number}`,
      )
      if (!pull.merged_at) continue
      const body = pull.body ?? ''
      pullRequests.push({
        body: compactPullRequestBody(body),
        commitShas: [...(commitsByPullRequest.get(number) ?? [])].sort(),
        issues: await closingIssues(repository, number),
        number: pull.number,
        repository,
        title: pull.title,
        url: pull.html_url,
        visuals: extractReleaseVisuals(body, { pullRequestNumber: pull.number, repository }),
      })
    }
    return pullRequests
  }

  async isAncestor(repository: string, ancestor: string, branch: string): Promise<boolean> {
    const comparison = await api<{ status: string }>(
      `repos/${repository}/compare/${encodeURIComponent(ancestor)}...${encodeURIComponent(branch)}`,
    )
    return comparison.status === 'ahead' || comparison.status === 'identical'
  }

  async dispatchWorkflow(input: {
    branch: string
    inputs: Record<string, string>
    repository: string
    workflow: string
  }): Promise<void> {
    await api(`repos/${input.repository}/actions/workflows/${encodeURIComponent(input.workflow)}/dispatches`, {
      body: { inputs: input.inputs, ref: input.branch },
      method: 'POST',
    })
  }

  async findWorkflowRun(input: {
    branch: string
    repository: string
    title: string
    workflow: string
  }): Promise<WorkflowRun | undefined> {
    const basePath = `repos/${input.repository}/actions/workflows/${encodeURIComponent(input.workflow)}/runs?event=workflow_dispatch&branch=${encodeURIComponent(input.branch)}`
    return findWorkflowRunInPages(input.title, async (page, perPage) => api<GitHubWorkflowRunsPage>(
      `${basePath}&per_page=${perPage}&page=${page}`,
    ))
  }

  async getRelease(repository: string, version: string): Promise<PlatformReleaseDetails | undefined> {
    const release = await findReleaseIncludingDraft(repository, version)
    return release ? platformReleaseDetails(repository, version, release) : undefined
  }

  async createDraftRelease(input: {
    body: string
    repository: string
    targetSha: string
    version: string
  }): Promise<PlatformReleaseDetails> {
    const existingRef = await optionalApi<{ object: { sha: string; type: string } }>(
      `repos/${input.repository}/git/ref/tags/${encodeURIComponent(input.version)}`,
    )
    if (existingRef) {
      const tagSha = await resolveTagSha(input.repository, input.version)
      if (tagSha !== input.targetSha) {
        throw new Error(`${input.repository} tag ${input.version} points to ${tagSha}, not ${input.targetSha}.`)
      }
    }
    const release = await api<GitHubRelease>(`repos/${input.repository}/releases`, {
      body: {
        body: input.body,
        draft: true,
        generate_release_notes: false,
        name: `findmydoc ${input.version}`,
        prerelease: false,
        tag_name: input.version,
        target_commitish: input.targetSha,
      },
      method: 'POST',
    })
    return platformReleaseDetails(input.repository, input.version, release)
  }

  async publishRelease(input: {
    releaseId: number
    repository: string
    version: string
  }): Promise<PlatformReleaseDetails> {
    const release = await api<GitHubRelease>(`repos/${input.repository}/releases/${input.releaseId}`, {
      body: { draft: false },
      method: 'PATCH',
    })
    const details = await platformReleaseDetails(input.repository, input.version, release)
    if (details.draft || !details.publishedAt) {
      throw new Error(`GitHub did not publish ${input.repository} ${input.version}.`)
    }
    return details
  }

  async ensureReleaseManifest(input: { manifest: string; repository: string; version: string }): Promise<void> {
    const release = await findReleaseIncludingDraft(input.repository, input.version)
    if (!release) throw new Error(`${input.repository} ${input.version} release does not exist.`)
    const asset = release.assets?.find((candidate) => candidate.name === 'platform-release.json')
    if (asset) {
      if (!asset.id) throw new Error(`${input.repository} platform-release.json has no asset ID.`)
      const existing = await runGh([
        'api',
        '--header',
        'Accept: application/octet-stream',
        `repos/${input.repository}/releases/assets/${asset.id}`,
      ])
      assertMatchingReleaseManifest(existing, input.manifest, input.repository, input.version)
      return
    }
    const directory = await mkdtemp(join(tmpdir(), 'fmd-platform-release-'))
    const path = join(directory, 'platform-release.json')
    try {
      await writeFile(path, input.manifest, 'utf8')
      try {
        await runGh(['release', 'upload', input.version, path, '--repo', input.repository])
      } catch (error) {
        const detail = safeGhErrorDetail(error)
        throw new Error(
          `Failed to upload platform-release.json to ${input.repository} ${input.version}${detail ? `: ${detail}` : '.'}`,
        )
      }
    } finally {
      await rm(directory, { force: true, recursive: true })
    }
  }

}

const ANNOUNCEMENT_ENVIRONMENT = 'platform-release-announcement'

function deploymentManifestDigest(payload: unknown): string | undefined {
  let candidate = payload
  if (typeof candidate === 'string') {
    try {
      candidate = JSON.parse(candidate) as unknown
    } catch {
      return undefined
    }
  }
  if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return undefined
  const digest = (candidate as { manifestDigest?: unknown }).manifestDigest
  return typeof digest === 'string' ? digest : undefined
}

export class GhPlatformReleaseAnnouncementStore implements PlatformReleaseAnnouncementStore {
  constructor(
    private readonly repository = 'findmydoc-platform/platform-release',
    private readonly ref = 'main',
    private readonly token = '',
    private readonly requestOverride?: GitHubApiRequest,
  ) {}

  private environment(): NodeJS.ProcessEnv {
    return this.token ? { ...process.env, GH_TOKEN: this.token } : process.env
  }

  private request<T>(path: string, options: GitHubApiOptions = {}): Promise<T> {
    return this.requestOverride
      ? this.requestOverride<T>(path, options)
      : api<T>(path, options, this.environment())
  }

  private async findDeployment(manifestDigest: string): Promise<GitHubDeployment | undefined> {
    for (let page = 1; ; page += 1) {
      const deployments = await this.request<GitHubDeployment[]>(
        `repos/${this.repository}/deployments?environment=${encodeURIComponent(ANNOUNCEMENT_ENVIRONMENT)}&per_page=100&page=${page}`,
      )
      const match = deployments.find((deployment) => deploymentManifestDigest(deployment.payload) === manifestDigest)
      if (match) return match
      if (deployments.length < 100) return undefined
    }
  }

  private async latestState(deploymentId: number): Promise<string | undefined> {
    const statuses = await this.request<GitHubDeploymentStatus[]>(
      `repos/${this.repository}/deployments/${deploymentId}/statuses?per_page=1`,
    )
    return statuses[0]?.state
  }

  async getState(manifestDigest: string): Promise<ReleaseAnnouncementState | undefined> {
    const deployment = await this.findDeployment(manifestDigest)
    if (!deployment) return undefined
    return await this.latestState(deployment.id) === 'success' ? 'sent' : 'pending'
  }

  async setState(input: {
    founderOpsUrl?: string
    manifestDigest: string
    state: ReleaseAnnouncementState
    version: string
  }): Promise<void> {
    let deployment = await this.findDeployment(input.manifestDigest)
    if (!deployment) {
      deployment = await this.request<GitHubDeployment>(`repos/${this.repository}/deployments`, {
        body: {
          auto_merge: false,
          description: `Google Chat announcement for findmydoc ${input.version}`,
          environment: ANNOUNCEMENT_ENVIRONMENT,
          payload: { manifestDigest: input.manifestDigest, schemaVersion: 1, version: input.version },
          production_environment: false,
          ref: this.ref,
          required_contexts: [],
          transient_environment: false,
        },
        method: 'POST',
      })
    }
    const expectedState = input.state === 'sent' ? 'success' : 'in_progress'
    if (await this.latestState(deployment.id) === expectedState) return
    await this.request(`repos/${this.repository}/deployments/${deployment.id}/statuses`, {
      body: {
        auto_inactive: false,
        description: input.state === 'sent' ? 'Google Chat announcement sent.' : 'Google Chat announcement pending.',
        environment: ANNOUNCEMENT_ENVIRONMENT,
        ...(input.state === 'sent' && input.founderOpsUrl ? { environment_url: input.founderOpsUrl } : {}),
        state: expectedState,
      },
      method: 'POST',
    })
  }
}

export function assertMatchingReleaseManifest(
  existing: string,
  expected: string,
  repository: string,
  version: string,
): void {
  if (existing !== expected) {
    throw new Error(`${repository} already has a different platform-release.json for ${version}.`)
  }
}
