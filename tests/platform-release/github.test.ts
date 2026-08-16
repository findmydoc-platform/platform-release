import { describe, expect, it } from 'vitest'
import {
  assertMatchingReleaseManifest,
  findWorkflowRunInPages,
  githubChildEnvironment,
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
})
