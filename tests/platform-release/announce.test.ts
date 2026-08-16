import { describe, expect, it, vi } from 'vitest'
import { announcePlatformReleaseOnce, assertPublishedPlatformRelease } from '../../src/platform-release/announce.js'
import type {
  PlatformReleaseAnnouncementStore,
  PlatformReleaseGitHubClient,
  PlatformReleaseManifestV2,
  ReleaseAnnouncementState,
} from '../../src/platform-release/types.js'

function manifest(): PlatformReleaseManifestV2 {
  return {
    changes: [],
    components: [
      { commits: [], deploymentRun: 'https://github.com/run/1', displayName: 'Clinic Dashboard', key: 'dashboard',
        productionUrl: 'https://clinics.findmydoc.eu', pullRequests: [], release: 'https://github.com/findmydoc-platform/clinic-dashboard/release',
        repository: 'findmydoc-platform/clinic-dashboard', targetSha: 'dashboard-target' },
      { commits: [], deploymentRun: 'https://github.com/run/2', displayName: 'Website', key: 'website',
        productionUrl: 'https://findmydoc.eu', pullRequests: [], release: 'https://github.com/findmydoc-platform/website/release',
        repository: 'findmydoc-platform/website', targetSha: 'website-target' },
    ],
    contentDigest: 'b'.repeat(64), highlights: [], manifestDigest: 'c'.repeat(64), planDigest: 'a'.repeat(64),
    publishedAt: '2026-08-12T12:00:00Z', schemaVersion: 2,
    summary: 'Bewertungen sind jetzt auf der gesamten Plattform verfügbar.', version: 'v0.46.0', visuals: [],
  }
}

function announcementGitHub(initial?: ReleaseAnnouncementState): {
  client: PlatformReleaseGitHubClient
  states: ReleaseAnnouncementState[]
  store: PlatformReleaseAnnouncementStore
} {
  const states: ReleaseAnnouncementState[] = initial ? [initial] : []
  const client = {
    async getRelease(repository: string) {
      const component = manifest().components.find((entry) => entry.repository === repository)!
      return { body: '', draft: false, id: 1, immutable: true, manifestAttached: true, preparedAt: '2026-08-12T11:59:00Z',
        publishedAt: '2026-08-12T12:00:00Z', sha: component.targetSha, url: component.release }
    },
  } as unknown as PlatformReleaseGitHubClient
  const store: PlatformReleaseAnnouncementStore = {
    async getState() { return states.at(-1) },
    async setState(input) { states.push(input.state) },
  }
  return { client, states, store }
}

const input = () => ({
  founderOpsUrl: 'https://founder-ops.findmydoc.eu/team/releases/v0.46.0',
  manifest: manifest(),
  webhook: 'https://chat.googleapis.com/v1/spaces/example/messages?key=key&token=token',
})

describe('platform release announcement resume', () => {
  it('rejects a draft before FounderOps or Google Chat can run', async () => {
    const { client } = announcementGitHub()
    client.getRelease = async (repository: string) => {
      const component = manifest().components.find((entry) => entry.repository === repository)!
      return { body: '', draft: true, id: 1, immutable: false, manifestAttached: true,
        platformPublishedAt: '2026-08-12T12:00:00.000Z', preparedAt: '2026-08-12T11:59:00Z',
        sha: component.targetSha, url: component.release }
    }
    await expect(assertPublishedPlatformRelease(manifest(), client)).rejects.toThrow('does not match')
  })

  it('sends only the compact German card and persists sent state', async () => {
    const { client, states, store } = announcementGitHub()
    const fetchMock = vi.fn(async () => new Response(null, { status: 200 }))
    await expect(announcePlatformReleaseOnce(input(), client, store, fetchMock)).resolves.toBe('sent')
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const request = fetchMock.mock.calls[0]![1] as RequestInit
    const body = JSON.parse(request.body as string) as Record<string, unknown>
    const serialized = JSON.stringify(body)
    expect(serialized).toContain('Bewertungen sind jetzt auf der gesamten Plattform verfügbar.')
    expect(serialized).toContain('Website · Clinic Dashboard')
    expect(serialized).toContain('Release in FounderOps öffnen')
    expect(serialized).toContain('https://founder-ops.findmydoc.eu/team/releases/v0.46.0')
    expect(serialized).not.toContain('imageUrl')
    expect(serialized).not.toContain('github.com/findmydoc-platform')
    expect(states).toEqual(['pending', 'sent'])

    await expect(announcePlatformReleaseOnce(input(), client, store, fetchMock)).resolves.toBe('already_sent')
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('fails closed on an ambiguous pending announcement', async () => {
    const { client, store } = announcementGitHub('pending')
    const fetchMock = vi.fn(async () => new Response(null, { status: 200 }))
    await expect(announcePlatformReleaseOnce(input(), client, store, fetchMock)).rejects.toThrow('announcement is pending')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('continues pending only with an explicit force decision', async () => {
    const { client, states, store } = announcementGitHub('pending')
    const fetchMock = vi.fn(async () => new Response(null, { status: 200 }))
    await expect(announcePlatformReleaseOnce({ ...input(), forcePending: true }, client, store, fetchMock)).resolves.toBe('sent')
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(states).toEqual(['pending', 'pending', 'sent'])
  })

  it('leaves both releases pending when Google Chat fails', async () => {
    const { client, states, store } = announcementGitHub()
    const fetchMock = vi.fn(async () => new Response(null, { status: 500 }))
    await expect(announcePlatformReleaseOnce(input(), client, store, fetchMock)).rejects.toThrow('HTTP 500')
    expect(states).toEqual(['pending'])
  })
})
