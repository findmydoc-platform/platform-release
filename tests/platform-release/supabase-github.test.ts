import { describe, expect, it } from 'vitest'
import { GitHubSupabaseOperations, GhSupabaseReleaseRunStore } from '../../src/platform-release/supabase-github.js'
import type { SupabaseReleaseContext } from '../../src/platform-release/types.js'
import { access, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { canonicalJson, sha256 } from '../../src/platform-release/canonical.js'

const repository = 'findmydoc-platform/ops'
const context: SupabaseReleaseContext = {
  schemaVersion: 1,
  environment: 'preview',
  version: 'v1.2.3',
  planDigest: 'a'.repeat(64),
  contentDigest: 'b'.repeat(64),
  opsSha: 'c'.repeat(40),
}

describe('GitHub Ops release boundary', () => {
  it.each(['duplicate', 'historic_conflict', 'invalid_status', 'later_deployment_page', 'later_status_page'])(
    'rejects %s durable journal evidence',
    async (kind) => {
      const payload = { schemaVersion: 1, contextDigest: sha256(canonicalJson(context)), release: context }
      const record = (runId: number | null) => ({
        state: 'in_progress',
        description: JSON.stringify({ schemaVersion: 1, runId }),
      })
      const paths: string[] = []
      const store = new GhSupabaseReleaseRunStore(async <T>(path: string): Promise<T> => {
        paths.push(path)
        const page = new URLSearchParams(path.split('?')[1]).get('page')
        if (path.includes('/statuses')) {
          if (kind === 'invalid_status') return [{ ...record(42), description: '{"schemaVersion":1,"runId":0}' }] as T
          if (kind === 'historic_conflict') return [record(42), record(99)] as T
          if (kind === 'later_status_page')
            return (page === '1' ? Array.from({ length: 100 }, () => record(42)) : [record(99)]) as T
          return [record(42)] as T
        }
        if (kind === 'duplicate')
          return [
            { id: 1, payload },
            { id: 2, payload },
          ] as T
        if (kind === 'later_deployment_page')
          return (
            page === '1'
              ? [{ id: 1, payload }, ...Array.from({ length: 99 }, (_, index) => ({ id: index + 2, payload: {} }))]
              : [{ id: 101, payload }]
          ) as T
        return [{ id: 1, payload }] as T
      })
      await expect(store.getRun(context)).rejects.toThrow()
      if (kind.startsWith('later_')) expect(paths.some((path) => path.endsWith('page=2'))).toBe(true)
    },
  )
  it('downloads only the unique current-attempt artifact and removes its local audit files', async () => {
    let directory = ''
    const run = {
      databaseId: 42,
      runAttempt: 2,
      headSha: context.opsSha,
      displayTitle: '',
      status: 'completed',
      conclusion: 'success',
      url: '',
    }
    const client = new GitHubSupabaseOperations(
      async <T>(): Promise<T> =>
        ({
          artifacts: [
            {
              id: 123,
              name: 'supabase-auth-config-42-2',
              digest: `sha256:${'f'.repeat(64)}`,
              expired: false,
              workflow_run: { id: 42, head_sha: context.opsSha },
              size_in_bytes: 100,
            },
          ],
        }) as T,
      async (args) => {
        expect(args.slice(0, 7)).toEqual([
          'run',
          'download',
          '42',
          '--repo',
          repository,
          '--name',
          'supabase-auth-config-42-2',
        ])
        directory = args[8]!
        await writeFile(join(directory, 'operator-result.json'), '{}\n')
        return ''
      },
    )
    expect(await client.getWorkflowArtifact(repository, run, 'supabase-auth-config-42-2')).toMatchObject({
      id: 123,
      files: { 'operator-result.json': '{}\n' },
    })
    await expect(access(directory)).rejects.toThrow()
  })

  it.each(['duplicate', 'expired', 'wrong_run', 'wrong_source'])(
    'rejects %s artifacts before download',
    async (kind) => {
      let downloads = 0
      const item = {
        id: 123,
        name: 'supabase-auth-config-42-1',
        digest: `sha256:${'f'.repeat(64)}`,
        expired: kind === 'expired',
        workflow_run: {
          id: kind === 'wrong_run' ? 99 : 42,
          head_sha: kind === 'wrong_source' ? '0'.repeat(40) : context.opsSha,
        },
        size_in_bytes: 100,
      }
      const client = new GitHubSupabaseOperations(
        async <T>(): Promise<T> => ({ artifacts: kind === 'duplicate' ? [item, item] : [item] }) as T,
        async () => {
          downloads += 1
          return ''
        },
      )
      await expect(
        client.getWorkflowArtifact(
          repository,
          {
            databaseId: 42,
            headSha: context.opsSha,
            runAttempt: 1,
            displayTitle: '',
            status: 'completed',
            conclusion: 'success',
            url: '',
          },
          item.name,
        ),
      ).rejects.toThrow()
      expect(downloads).toBe(0)
    },
  )
  it('pins the dispatch API version and retrieves the returned run ID without a title search', async () => {
    const calls: unknown[] = []
    const client = new GitHubSupabaseOperations(
      async <T>(path: string, options?: unknown): Promise<T> => {
        calls.push({ path, options })
        if (path.endsWith('/dispatches'))
          return {
            workflow_run_id: 42,
            run_url: `https://api.github.com/repos/${repository}/actions/runs/42`,
            html_url: `https://github.com/${repository}/actions/runs/42`,
          } as T
        return {
          id: 42,
          run_attempt: 1,
          event: 'workflow_dispatch',
          head_branch: 'main',
          head_sha: context.opsSha,
          path: '.github/workflows/supabase-auth-config.yml',
          display_title: 'Supabase Auth Config release apply 42',
          status: 'queued',
          conclusion: null,
          html_url: `https://github.com/${repository}/actions/runs/42`,
        } as T
      },
      async () => '',
    )
    expect(
      await client.dispatchWorkflowRun({
        repository,
        branch: 'main',
        workflow: 'supabase-auth-config.yml',
        inputs: { operation: 'apply', apply_changes: 'true', release_context: JSON.stringify(context) },
      }),
    ).toEqual({ databaseId: 42, url: `https://github.com/${repository}/actions/runs/42` })
    expect(calls).toEqual([
      {
        path: `repos/${repository}/actions/workflows/supabase-auth-config.yml/dispatches`,
        options: {
          method: 'POST',
          apiVersion: '2026-03-10',
          body: {
            ref: 'main',
            inputs: { operation: 'apply', apply_changes: 'true', release_context: JSON.stringify(context) },
          },
        },
      },
    ])
  })

  it('keeps an ambiguous dispatch intent across process instances and never overwrites an assigned run', async () => {
    const deployments: Array<{ id: number; payload: unknown }> = []
    const statuses: Record<number, Array<{ state: string; description: string }>> = {}
    const request = async <T>(path: string, options?: { method?: string; body?: unknown }): Promise<T> => {
      const body = options?.body as Record<string, unknown>
      if (path.includes('/statuses')) {
        const id = Number(path.match(/deployments\/(\d+)/)![1])
        if (options?.method === 'POST') {
          statuses[id] = [body as { state: string; description: string }, ...(statuses[id] ?? [])]
          return {} as T
        }
        return (statuses[id] ?? []) as T
      }
      if (options?.method === 'POST') {
        const deployment = { id: deployments.length + 1, payload: body.payload }
        deployments.push(deployment)
        return deployment as T
      }
      return deployments as T
    }
    const first = new GhSupabaseReleaseRunStore(request)
    expect(await first.getRun(context)).toBeUndefined()
    await first.begin(context)
    const resumed = new GhSupabaseReleaseRunStore(request)
    expect(await resumed.getRun(context)).toBeNull()
    await expect(resumed.begin(context)).rejects.toThrow()
    await resumed.recordRun(context, 42)
    expect(await first.getRun(context)).toBe(42)
    await resumed.recordRun(context, 42)
    await expect(resumed.recordRun(context, 99)).rejects.toThrow()
    expect(deployments).toHaveLength(1)
  })
})
