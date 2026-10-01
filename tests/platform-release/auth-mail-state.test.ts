import { describe, expect, it } from 'vitest'
import { GhAuthMailStateStore } from '../../src/platform-release/github.js'
import { canonicalJson, sha256 } from '../../src/platform-release/canonical.js'
import { suppressionBinding } from './auth-mail-fixtures.js'

const context = {
  binding: suppressionBinding,
  contentDigest: 'd'.repeat(64),
  planDigest: 'e'.repeat(64),
  version: 'v0.46.0',
  previousShas: { dashboard: 'b'.repeat(40), website: 'c'.repeat(40) },
}

describe('GitHub Auth mail release state', () => {
  const payload = {
    bindingDigest: sha256(canonicalJson(context.binding)),
    contentDigest: context.contentDigest,
    planDigest: context.planDigest,
    schemaVersion: 1,
    version: context.version,
  }
  const storeFor = (deployments: unknown[], statuses: unknown[]) => {
    const paths: string[] = []
    const request = async <T>(path: string): Promise<T> => {
      paths.push(path)
      const page = Number(new URL(`https://api.github.com/${path}`).searchParams.get('page'))
      const rows = path.includes('/statuses') ? statuses : deployments
      return rows.slice((page - 1) * 100, page * 100) as T
    }
    return { paths, store: new GhAuthMailStateStore('findmydoc-platform/platform-release', 'main', '', request) }
  }

  it.each([
    undefined,
    'not-json',
    '{"rollback":false,"state":"unknown"}',
    '{"rollback":true,"state":"published"}',
    '{"rollback":false,"state":"deploying","recipient":"synthetic"}',
    '{"state":"deploying"}',
  ])('rejects malformed persisted phase %s without returning usable progress', async (description) => {
    const { store } = storeFor([{ id: 1, payload }], [{ description }])
    await expect(store.getState(context)).rejects.toThrow('state is invalid')
  })

  it('rejects an identity with no recorded status', async () => {
    await expect(storeFor([{ id: 1, payload }], []).store.getState(context)).rejects.toThrow('state is invalid')
  })

  it('rejects duplicate identities even when the second appears on another page', async () => {
    const deployments = [
      { id: 1, payload },
      ...Array.from({ length: 99 }, (_, index) => ({ id: index + 2, payload: { planDigest: 'unrelated' } })),
      { id: 101, payload: JSON.stringify(payload) },
    ]
    const { store, paths } = storeFor(deployments, [])
    await expect(store.getState(context)).rejects.toThrow('Duplicate')
    expect(paths).toHaveLength(2)
  })

  it('reads the release identity and an older permanent rollback on subsequent pages', async () => {
    const deployments = [
      ...Array.from({ length: 100 }, (_, index) => ({ id: index + 1, payload: { planDigest: 'unrelated' } })),
      { id: 101, payload: JSON.stringify(payload) },
    ]
    const statuses = [
      ...Array.from({ length: 100 }, () => ({ description: '{"rollback":false,"state":"deploying"}' })),
      { description: '{"rollback":true,"state":"rollback-required"}' },
    ]
    const { store, paths } = storeFor(deployments, statuses)
    expect(await store.getState(context)).toEqual({ rollback: true, state: 'rollback-required' })
    expect(paths).toHaveLength(4)
  })

  it('rejects malformed persisted JSON identity', async () => {
    await expect(storeFor([{ id: 1, payload: '{' }], []).store.getState(context)).rejects.toThrow('identity is invalid')
  })

  it('rejects malformed older history even when the latest phase is valid', async () => {
    const { store } = storeFor(
      [{ id: 1, payload }],
      [{ description: '{"rollback":false,"state":"deploying"}' }, { description: '{}' }],
    )
    await expect(store.getState(context)).rejects.toThrow('state is invalid')
  })

  it('never clears an explicit rollback latch, including a stale status appended after it', async () => {
    let deployment: { id: number; payload: unknown } | undefined
    const statuses: Array<{ description: string }> = []
    const request = async <T>(path: string, options?: { method?: string; body?: unknown }): Promise<T> => {
      if (options?.method === 'POST' && path.endsWith('/deployments')) {
        deployment = { id: 1, payload: (options.body as { payload: unknown }).payload }
        return deployment as T
      }
      if (options?.method === 'POST') {
        statuses.unshift(options.body as { description: string })
        return {} as T
      }
      return (path.includes('/statuses') ? statuses : deployment ? [deployment] : []) as T
    }
    const store = new GhAuthMailStateStore('findmydoc-platform/platform-release', 'main', '', request)
    await store.setState(context, { rollback: true, state: 'rollback-required' })
    await expect(store.setState(context, { rollback: false, state: 'deploying' })).rejects.toThrow('rollback')
    statuses.unshift({ description: '{"rollback":false,"state":"deploying"}' })
    expect(await store.getState(context)).toEqual({ rollback: true, state: 'rollback-required' })
  })
  it('resumes the same durable plan and content identity across store instances', async () => {
    let deployments: unknown[] = []
    let statuses: unknown[] = []
    const request = async <T>(path: string, options?: { method?: string; body?: unknown }): Promise<T> => {
      if (options?.method === 'POST' && path.endsWith('/deployments')) {
        const deployment = { id: 1, payload: (options.body as { payload: unknown }).payload }
        deployments = [deployment]
        return deployment as T
      }
      if (options?.method === 'POST') {
        statuses = [options.body]
        return {} as T
      }
      return (path.includes('/statuses') ? statuses : deployments) as T
    }
    const first = new GhAuthMailStateStore('findmydoc-platform/platform-release', 'main', '', request)
    await first.setState(context, { rollback: false, state: 'cutover-applied' })
    const resumed = new GhAuthMailStateStore('findmydoc-platform/platform-release', 'main', '', request)
    expect(await resumed.getState(context)).toEqual({ rollback: false, state: 'cutover-applied' })
    await expect(resumed.getState({ ...context, contentDigest: 'f'.repeat(64) })).rejects.toThrow('conflicting')
    expect(JSON.stringify(deployments)).not.toContain('previousShas')
  })
})
