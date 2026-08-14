import type { FounderOpsReleaseClient } from './types.js'

type Fetch = typeof fetch

export class HttpFounderOpsReleaseClient implements FounderOpsReleaseClient {
  readonly endpoint: URL

  constructor(
    baseUrl: string,
    ingestPath: string,
    private readonly token: string,
    private readonly fetchImpl: Fetch = fetch,
  ) {
    if (!token) throw new Error('FOUNDEROPS_PLATFORM_RELEASE_TOKEN is required.')
    this.endpoint = new URL(ingestPath, baseUrl)
    if (this.endpoint.protocol !== 'https:') throw new Error('FounderOps release ingestion must use HTTPS.')
  }

  async ingestManifest(input: { manifest: string; manifestDigest: string }): Promise<{ replayed: boolean; url: string }> {
    const response = await this.fetchImpl(this.endpoint, {
      body: input.manifest,
      headers: {
        authorization: `Bearer ${this.token}`,
        'content-type': 'application/json',
        'idempotency-key': `platform-release:${input.manifestDigest}`,
      },
      method: 'POST',
      signal: AbortSignal.timeout(30_000),
    })
    if (response.status !== 200 && response.status !== 201) {
      throw new Error(`FounderOps release ingestion failed with HTTP ${response.status}.`)
    }
    let body: unknown
    try {
      body = await response.json()
    } catch {
      throw new Error('FounderOps release ingestion returned invalid JSON.')
    }
    const value = body as { ok?: unknown; replayed?: unknown; release?: { url?: unknown } }
    if (value.ok !== true || typeof value.replayed !== 'boolean' || typeof value.release?.url !== 'string') {
      throw new Error('FounderOps release ingestion returned an invalid response contract.')
    }
    let url: URL
    try {
      url = new URL(value.release.url)
    } catch {
      throw new Error('FounderOps release ingestion returned an invalid release URL.')
    }
    if (url.protocol !== 'https:' || url.origin !== this.endpoint.origin || url.username || url.password) {
      throw new Error('FounderOps release ingestion returned an untrusted release URL.')
    }
    return { replayed: value.replayed, url: url.toString() }
  }
}
