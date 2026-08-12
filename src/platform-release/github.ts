import { spawn } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { bumpForMessage, compareVersions, parseVersion } from './semver.js'
import { extractReleaseVisuals } from './visuals.js'
import type {
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
  html_url?: string
  id?: number
  published_at?: string | null
  prerelease?: boolean
  draft?: boolean
  tag_name?: string
}

const ANNOUNCEMENT_MARKER = /<!--\s*findmydoc-platform-announcement:(pending|sent)\s*-->/

function announcementState(body: string | null | undefined): ReleaseAnnouncementState | undefined {
  const value = body?.match(ANNOUNCEMENT_MARKER)?.[1]
  return value === 'pending' || value === 'sent' ? value : undefined
}

class GhError extends Error {
  constructor(message: string, readonly stderr: string) {
    super(message)
  }
}

function childEnvironment(): NodeJS.ProcessEnv {
  const allowlist = [
    'GH_ENTERPRISE_TOKEN',
    'GH_HOST',
    'GH_TOKEN',
    'GITHUB_TOKEN',
    'HOME',
    'LANG',
    'LC_ALL',
    'PATH',
    'XDG_CONFIG_HOME',
  ] as const
  return Object.fromEntries(allowlist.flatMap((key) => process.env[key] === undefined ? [] : [[key, process.env[key]]]))
}

async function runGh(args: string[], input?: string): Promise<string> {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn('gh', args, {
      env: childEnvironment(),
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

async function api<T>(path: string, options: { method?: string; body?: unknown } = {}): Promise<T> {
  const args = ['api', path]
  if (options.method) args.push('--method', options.method)
  if (options.body !== undefined) args.push('--input', '-')
  const output = await runGh(args, options.body === undefined ? undefined : JSON.stringify(options.body))
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
    const response = await api<{ workflow_runs: Array<{
      conclusion: string | null
      display_title: string
      html_url: string
      id: number
      status: string
    }> }>(
      `repos/${input.repository}/actions/workflows/${encodeURIComponent(input.workflow)}/runs?event=workflow_dispatch&branch=${encodeURIComponent(input.branch)}&per_page=50`,
    )
    const run = response.workflow_runs.find((candidate) => candidate.display_title === input.title)
    return run ? {
      conclusion: run.conclusion,
      databaseId: run.id,
      displayTitle: run.display_title,
      status: run.status,
      url: run.html_url,
    } : undefined
  }

  async getRelease(repository: string, version: string): Promise<PlatformReleaseDetails | undefined> {
    const release = await optionalApi<GitHubRelease>(`repos/${repository}/releases/tags/${encodeURIComponent(version)}`)
    if (!release?.html_url || !release.id || !release.published_at) return undefined
    return {
      announcementState: announcementState(release.body),
      body: release.body ?? '',
      id: release.id,
      publishedAt: release.published_at,
      sha: await resolveTagSha(repository, version),
      url: release.html_url,
    }
  }

  async setReleaseAnnouncementState(input: {
    repository: string
    state: ReleaseAnnouncementState
    version: string
  }): Promise<void> {
    const release = await api<GitHubRelease>(
      `repos/${input.repository}/releases/tags/${encodeURIComponent(input.version)}`,
    )
    if (!release.id) throw new Error(`GitHub release ${input.repository} ${input.version} has no ID.`)
    const marker = `<!-- findmydoc-platform-announcement:${input.state} -->`
    const currentBody = release.body ?? ''
    const body = ANNOUNCEMENT_MARKER.test(currentBody)
      ? currentBody.replace(ANNOUNCEMENT_MARKER, marker)
      : `${currentBody.trim()}\n\n${marker}\n`
    await api(`repos/${input.repository}/releases/${release.id}`, {
      body: { body },
      method: 'PATCH',
    })
  }

  async createRelease(input: {
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
        draft: false,
        generate_release_notes: false,
        name: `findmydoc ${input.version}`,
        prerelease: false,
        tag_name: input.version,
        target_commitish: input.targetSha,
      },
      method: 'POST',
    })
    if (!release.id || !release.html_url || !release.published_at) {
      throw new Error(`GitHub did not return the created release for ${input.repository}.`)
    }
    return {
      body: input.body,
      id: release.id,
      publishedAt: release.published_at,
      sha: await resolveTagSha(input.repository, input.version),
      url: release.html_url,
    }
  }

  async ensureReleaseManifest(input: { manifest: string; repository: string; version: string }): Promise<void> {
    const release = await api<GitHubRelease>(`repos/${input.repository}/releases/tags/${encodeURIComponent(input.version)}`)
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
      await runGh(['release', 'upload', input.version, path, '--repo', input.repository])
    } finally {
      await rm(directory, { force: true, recursive: true })
    }
  }

  async findIssueComment(input: { issue: ReleaseIssue; marker: string }): Promise<boolean> {
    const comments = await api<Array<{ body?: string }>>(
      `repos/${input.issue.repository}/issues/${input.issue.number}/comments?per_page=100`,
    )
    return comments.some((comment) => comment.body?.includes(input.marker))
  }

  async addIssueComment(input: { body: string; issue: ReleaseIssue }): Promise<void> {
    await api(`repos/${input.issue.repository}/issues/${input.issue.number}/comments`, {
      body: { body: input.body },
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
