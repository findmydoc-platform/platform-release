import { describe, expect, it } from 'vitest'
import { createPlatformReleaseManifest, serializePlatformReleaseManifest } from '../../src/platform-release/manifest.js'
import type {
  PlatformReleaseConfig,
  PlatformReleaseContent,
  PlatformReleasePlan,
} from '../../src/platform-release/types.js'

const config = {
  repositories: {
    dashboard: { displayName: 'Clinic Dashboard', productionUrl: 'https://clinics.findmydoc.eu' },
    website: { displayName: 'Website', productionUrl: 'https://findmydoc.eu' },
  },
} as PlatformReleaseConfig

const content: PlatformReleaseContent = {
  changes: [{ id: 'reviews', kind: 'feature', pullRequests: [{ number: 1, repository: 'org/website' }],
    section: 'public', summary: 'Bewertungen sind sichtbar.', title: 'Bewertungen', visualUrls: [] }],
  highlights: ['reviews'], schemaVersion: 1, summary: 'Bewertungen sind jetzt auf der Website verfügbar.',
}

const plan = {
  digest: 'a'.repeat(64),
  repositories: {
    dashboard: { commits: [], pullRequests: [], repository: 'org/dashboard', targetSha: 'dashboard-sha' },
    website: { commits: [{ bump: 'minor', message: 'feat: reviews', sha: 'website-sha', url: 'https://github.com/commit' }],
      pullRequests: [{ body: 'must not leak into manifest', commitShas: ['website-sha'], issues: [], number: 1,
        repository: 'org/website', title: 'Reviews', url: 'https://github.com/org/website/pull/1', visuals: [] }],
      repository: 'org/website', targetSha: 'website-sha' },
  },
  version: 'v0.46.0', visualCandidates: [],
} as PlatformReleasePlan

describe('platform release manifest v2', () => {
  it('contains complete provenance with a self-verifying digest', () => {
    const manifest = createPlatformReleaseManifest({
      config, content, contentDigest: 'b'.repeat(64), plan,
      releases: {
        dashboard: { body: '', draft: true, id: 1, immutable: false, preparedAt: '2026-08-12T11:00:00Z',
          sha: 'dashboard-sha', url: 'https://github.com/org/dashboard/releases/v0.46.0' },
        website: { body: '', draft: true, id: 2, immutable: false, preparedAt: '2026-08-12T12:00:00Z',
          sha: 'website-sha', url: 'https://github.com/org/website/releases/v0.46.0' },
      },
      workflows: {
        dashboard: { conclusion: 'success', databaseId: 1, displayTitle: 'dashboard', status: 'completed', url: 'https://github.com/run/1' },
        website: { conclusion: 'success', databaseId: 2, displayTitle: 'website', status: 'completed', url: 'https://github.com/run/2' },
      },
    })
    expect(manifest).toMatchObject({ publishedAt: '2026-08-12T12:00:00Z', schemaVersion: 2, version: 'v0.46.0' })
    expect(manifest.components[1]?.pullRequests[0]).toMatchObject({ commitShas: ['website-sha'], number: 1 })
    expect(manifest.components[1]?.pullRequests[0]).not.toHaveProperty('body')
    expect(serializePlatformReleaseManifest(manifest)).toContain(`"manifestDigest": "${manifest.manifestDigest}"`)
    expect(() => serializePlatformReleaseManifest({ ...manifest, summary: 'tampered' })).toThrow('digest mismatch')
  })
})
