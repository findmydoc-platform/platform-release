import { describe, expect, it, vi } from 'vitest'
import { announcePlatformReleaseOnce } from '../../src/platform-release/announce.js'
import type {
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
  states: Map<string, ReleaseAnnouncementState | undefined>
} {
  const states = new Map<string, ReleaseAnnouncementState | undefined>([
    ['findmydoc-platform/website', initial], ['findmydoc-platform/clinic-dashboard', initial],
  ])
  const client = {
    async getRelease(repository: string) {
      const component = manifest().components.find((entry) => entry.repository === repository)!
      return { announcementState: states.get(repository), body: '', id: 1, publishedAt: '2026-08-12T12:00:00Z',
        sha: component.targetSha, url: component.release }
    },
    async setReleaseAnnouncementState(input: { repository: string; state: ReleaseAnnouncementState }) {
      states.set(input.repository, input.state)
    },
  } as unknown as PlatformReleaseGitHubClient
  return { client, states }
}

const input = () => ({
  founderOpsUrl: 'https://founder-ops.findmydoc.eu/team/releases/v0.46.0',
  manifest: manifest(),
  webhook: 'https://chat.googleapis.com/v1/spaces/example/messages?key=key&token=token',
})

describe('platform release announcement resume', () => {
  it('sends only the compact German card and persists sent state', async () => {
    const { client, states } = announcementGitHub()
    const fetchMock = vi.fn(async () => new Response(null, { status: 200 }))
    await expect(announcePlatformReleaseOnce(input(), client, fetchMock)).resolves.toBe('sent')
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
    expect([...states.values()]).toEqual(['sent', 'sent'])

    await expect(announcePlatformReleaseOnce(input(), client, fetchMock)).resolves.toBe('already_sent')
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('fails closed on an ambiguous pending announcement', async () => {
    const { client } = announcementGitHub('pending')
    const fetchMock = vi.fn(async () => new Response(null, { status: 200 }))
    await expect(announcePlatformReleaseOnce(input(), client, fetchMock)).rejects.toThrow('announcement is pending')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('continues pending only with an explicit force decision', async () => {
    const { client, states } = announcementGitHub('pending')
    const fetchMock = vi.fn(async () => new Response(null, { status: 200 }))
    await expect(announcePlatformReleaseOnce({ ...input(), forcePending: true }, client, fetchMock)).resolves.toBe('sent')
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect([...states.values()]).toEqual(['sent', 'sent'])
  })

  it('leaves both releases pending when Google Chat fails', async () => {
    const { client, states } = announcementGitHub()
    const fetchMock = vi.fn(async () => new Response(null, { status: 500 }))
    await expect(announcePlatformReleaseOnce(input(), client, fetchMock)).rejects.toThrow('HTTP 500')
    expect([...states.values()]).toEqual(['pending', 'pending'])
  })
})
