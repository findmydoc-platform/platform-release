import { describe, expect, it, vi } from 'vitest'
import { announcePlatformReleaseOnce } from '../../src/platform-release/announce.js'
import { computePlanDigest } from '../../src/platform-release/plan.js'
import type {
  PlatformReleaseGitHubClient,
  PlatformReleasePlan,
  ReleaseAnnouncementState,
} from '../../src/platform-release/types.js'

function plan(): PlatformReleasePlan {
  const value: Omit<PlatformReleasePlan, 'digest'> = {
    breakingChanges: [],
    createdAt: '2026-08-08T10:00:00.000Z',
    highestBump: 'patch',
    manualVersion: false,
    repositories: {
      dashboard: {
        base: { kind: 'cutover', sha: 'dashboard-base' }, branch: 'main', commits: [],
        deploymentWorkflow: 'platform-release-deploy.yml', productionUrl: 'https://clinics.findmydoc.eu',
        pullRequests: [], repository: 'findmydoc-platform/clinic-dashboard', surface: 'Dashboard for clinics',
        targetSha: 'dashboard-target',
      },
      website: {
        base: { kind: 'release', sha: 'website-base', version: 'v0.45.0' }, branch: 'main', commits: [],
        deploymentWorkflow: 'platform-release-deploy.yml', productionUrl: 'https://findmydoc.eu', pullRequests: [],
        repository: 'findmydoc-platform/website', surface: 'Public platform', targetSha: 'website-target',
      },
    },
    schemaVersion: 1,
    version: 'v0.45.1',
    visualCandidates: [],
  }
  return { ...value, digest: computePlanDigest(value) }
}

function announcementGitHub(initial?: ReleaseAnnouncementState): {
  client: PlatformReleaseGitHubClient
  states: Map<string, ReleaseAnnouncementState | undefined>
} {
  const states = new Map<string, ReleaseAnnouncementState | undefined>([
    ['findmydoc-platform/website', initial],
    ['findmydoc-platform/clinic-dashboard', initial],
  ])
  const client = {
    async getRelease(repository: string) {
      return { announcementState: states.get(repository), id: 1, sha: 'target', url: `https://github.com/${repository}/release` }
    },
    async setReleaseAnnouncementState(input: { repository: string; state: ReleaseAnnouncementState }) {
      states.set(input.repository, input.state)
    },
  } as unknown as PlatformReleaseGitHubClient
  return { client, states }
}

const input = () => ({
  notes: '## Platform release\nShared.\n## Dashboard for clinics\nDashboard.\n## Public platform\nWebsite.',
  plan: plan(),
  releaseUrls: { dashboard: 'https://example.test/dashboard', website: 'https://example.test/website' },
  visuals: [],
  webhook: 'https://chat.googleapis.com/v1/spaces/example/messages?key=key&token=token',
})

describe('platform release announcement resume', () => {
  it('persists sent state and skips a duplicate announcement', async () => {
    const { client, states } = announcementGitHub()
    const fetchMock = vi.fn(async () => new Response(null, { status: 200 }))
    await expect(announcePlatformReleaseOnce(input(), client, fetchMock)).resolves.toBe('sent')
    expect(fetchMock).toHaveBeenCalledTimes(1)
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

  it('continues a pending announcement only with an explicit force decision', async () => {
    const { client, states } = announcementGitHub('pending')
    const fetchMock = vi.fn(async () => new Response(null, { status: 200 }))
    await expect(announcePlatformReleaseOnce({ ...input(), forcePending: true }, client, fetchMock)).resolves.toBe('sent')
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect([...states.values()]).toEqual(['sent', 'sent'])
  })
})
