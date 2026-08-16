import { describe, expect, it } from 'vitest'
import {
  assertMatchingReleaseManifest,
  findWorkflowRunInPages,
  GhPlatformReleaseAnnouncementStore,
  githubChildEnvironment,
  safeGhErrorDetail,
} from '../../src/platform-release/github.js'

function workflowRun(id: number, title: string) {
  return {
    conclusion: 'success',
    display_title: title,
    html_url: `https://github.com/findmydoc-platform/website/actions/runs/${id}`,
    id,
    status: 'completed',
  }
}

describe('GitHub release manifest resume', () => {
  it('accepts byte-identical assets and rejects different existing content', () => {
    expect(() => assertMatchingReleaseManifest('{"same":true}\n', '{"same":true}\n', 'org/repo', 'v0.46.0')).not.toThrow()
    expect(() => assertMatchingReleaseManifest('{"old":true}\n', '{"new":true}\n', 'org/repo', 'v0.46.0'))
      .toThrow('already has a different platform-release.json')
  })

  it('preserves cross-platform GitHub CLI configuration without forwarding unrelated secrets', () => {
    expect(githubChildEnvironment({
      APPDATA: 'windows-config',
      GH_TOKEN: 'github-token',
      HOME: 'unix-home',
      PATH: 'commands',
      SystemRoot: 'windows-root',
      UNRELATED_SECRET: 'must-not-pass',
      USERPROFILE: 'windows-home',
    })).toEqual({
      APPDATA: 'windows-config',
      GH_TOKEN: 'github-token',
      HOME: 'unix-home',
      PATH: 'commands',
      SystemRoot: 'windows-root',
      USERPROFILE: 'windows-home',
    })
  })

  it('redacts credentials from GitHub CLI diagnostics', () => {
    const detail = safeGhErrorDetail(new Error(
      'upload failed for ghs_exampleSecret Authorization: Bearer another-secret',
    ))
    expect(detail).toContain('upload failed for [redacted]')
    expect(detail).toContain('Authorization: Bearer [redacted]')
    expect(detail).not.toContain('exampleSecret')
    expect(detail).not.toContain('another-secret')
  })

  it('finds an existing deployment run beyond the first workflow-runs page', async () => {
    const requestedPages: Array<{ page: number; perPage: number }> = []
    const match = workflowRun(101, 'findmydoc v0.46.0 · digest · website-target')
    const result = await findWorkflowRunInPages(match.display_title, async (page, perPage) => {
      requestedPages.push({ page, perPage })
      return {
        workflow_runs: page === 1
          ? Array.from({ length: 100 }, (_, index) => workflowRun(index + 1, `other-${index + 1}`))
          : [match],
      }
    })

    expect(requestedPages).toEqual([{ page: 1, perPage: 100 }, { page: 2, perPage: 100 }])
    expect(result).toEqual({
      conclusion: 'success',
      databaseId: 101,
      displayTitle: match.display_title,
      status: 'completed',
      url: match.html_url,
    })
  })

  it('persists announcement state as one GitHub deployment per manifest digest', async () => {
    const deployments: Array<{ id: number; payload: unknown }> = []
    const statuses = new Map<number, Array<{ state: string }>>()
    const request = async <T>(path: string, options: { body?: unknown; method?: string } = {}): Promise<T> => {
      if (path.includes('/deployments?')) return deployments as T
      const statusMatch = path.match(/\/deployments\/(\d+)\/statuses/)
      if (statusMatch) {
        const deploymentId = Number(statusMatch[1])
        if (options.method === 'POST') {
          const body = options.body as { state: string }
          statuses.set(deploymentId, [{ state: body.state }, ...(statuses.get(deploymentId) ?? [])])
          return {} as T
        }
        return (statuses.get(deploymentId) ?? []) as T
      }
      if (path.endsWith('/deployments') && options.method === 'POST') {
        const body = options.body as { payload: unknown }
        const deployment = { id: deployments.length + 1, payload: body.payload }
        deployments.push(deployment)
        return deployment as T
      }
      throw new Error(`Unexpected request: ${path}`)
    }
    const store = new GhPlatformReleaseAnnouncementStore('findmydoc-platform/platform-release', 'main', '', request)
    const manifestDigest = 'a'.repeat(64)

    await expect(store.getState(manifestDigest)).resolves.toBeUndefined()
    await store.setState({ manifestDigest, state: 'pending', version: 'v0.46.1' })
    await expect(store.getState(manifestDigest)).resolves.toBe('pending')
    await store.setState({ founderOpsUrl: 'https://founder-ops.findmydoc.eu/releases/v0.46.1', manifestDigest,
      state: 'sent', version: 'v0.46.1' })
    await expect(store.getState(manifestDigest)).resolves.toBe('sent')
    expect(deployments).toHaveLength(1)
  })
})
