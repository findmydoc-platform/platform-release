import { describe, expect, it, vi } from 'vitest'
import { HttpFounderOpsReleaseClient } from '../../src/platform-release/founder-ops.js'

const endpoint = 'https://founder-ops.findmydoc.eu'
const path = '/api/team/platform-releases/v1/releases'
const manifest = '{"schemaVersion":2}\n'
const digest = 'a'.repeat(64)

describe('FounderOps release ingestion adapter', () => {
  it.each([
    [201, false],
    [200, true],
  ])('accepts HTTP %s and returns the trusted release URL', async (status, replayed) => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      ok: true, replayed, release: { url: `${endpoint}/team/platform-releases/v0.46.0` },
    }), { headers: { 'content-type': 'application/json' }, status }))
    const client = new HttpFounderOpsReleaseClient(endpoint, path, 'secret', fetchMock)
    await expect(client.ingestManifest({ manifest, manifestDigest: digest })).resolves.toEqual({
      replayed, url: `${endpoint}/team/platform-releases/v0.46.0`,
    })
    const [url, request] = fetchMock.mock.calls[0]!
    expect(String(url)).toBe(`${endpoint}${path}`)
    expect(request.body).toBe(manifest)
    expect(request.headers).toMatchObject({
      authorization: 'Bearer secret', 'content-type': 'application/json', 'idempotency-key': `platform-release:${digest}`,
    })
  })

  it.each([400, 403, 409, 500])('rejects HTTP %s without exposing the response body', async (status) => {
    const fetchMock = vi.fn(async () => new Response('sensitive detail', { status }))
    const client = new HttpFounderOpsReleaseClient(endpoint, path, 'secret', fetchMock)
    await expect(client.ingestManifest({ manifest, manifestDigest: digest })).rejects.toThrow(`HTTP ${status}`)
    await expect(client.ingestManifest({ manifest, manifestDigest: digest })).rejects.not.toThrow('sensitive detail')
  })

  it('rejects a response URL from another origin', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      ok: true, replayed: false, release: { url: 'https://example.test/releases/v0.46.0' },
    }), { status: 201 }))
    const client = new HttpFounderOpsReleaseClient(endpoint, path, 'secret', fetchMock)
    await expect(client.ingestManifest({ manifest, manifestDigest: digest })).rejects.toThrow('untrusted')
  })
})
