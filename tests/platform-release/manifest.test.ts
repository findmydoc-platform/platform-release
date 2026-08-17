import { describe, expect, it } from 'vitest'
import {
  createPlatformReleaseManifest,
  createPlatformReleaseManifestV3,
  serializePlatformReleaseManifest,
  serializeReleaseManifest,
  validateReleaseManifest,
} from '../../src/platform-release/manifest.js'
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

const dashboardSha = 'd'.repeat(40)
const websiteSha = 'e'.repeat(40)

const plan = {
  digest: 'a'.repeat(64),
  repositories: {
    dashboard: { commits: [], pullRequests: [], repository: 'org/dashboard', targetSha: dashboardSha },
    website: { commits: [{ bump: 'minor', message: 'feat: reviews', sha: websiteSha, url: `https://github.com/org/website/commit/${websiteSha}` }],
      pullRequests: [{ body: 'must not leak into manifest', commitShas: [websiteSha], issues: [], number: 1,
        repository: 'org/website', title: 'Reviews', url: 'https://github.com/org/website/pull/1', visuals: [] }],
      repository: 'org/website', targetSha: websiteSha },
  },
  version: 'v0.46.0', visualCandidates: [],
} as PlatformReleasePlan

describe('platform release manifest v2', () => {
  it('contains complete provenance with a self-verifying digest', () => {
    const manifest = createPlatformReleaseManifest({
      config, content, contentDigest: 'b'.repeat(64), plan,
      releases: {
        dashboard: { body: '', draft: true, id: 1, immutable: false, manifestAttached: false,
          platformPublishedAt: '2026-08-12T12:00:00.000Z', preparedAt: '2026-08-12T11:00:00Z',
          sha: dashboardSha, url: 'https://github.com/org/dashboard/releases/tag/v0.46.0' },
        website: { body: '', draft: true, id: 2, immutable: false, manifestAttached: false,
          platformPublishedAt: '2026-08-12T12:00:00.000Z', preparedAt: '2026-08-12T12:00:00Z',
          sha: websiteSha, url: 'https://github.com/org/website/releases/tag/v0.46.0' },
      },
      workflows: {
        dashboard: { conclusion: 'success', databaseId: 1, displayTitle: 'dashboard', status: 'completed', url: 'https://github.com/run/1' },
        website: { conclusion: 'success', databaseId: 2, displayTitle: 'website', status: 'completed', url: 'https://github.com/run/2' },
      },
    })
    expect(manifest).toMatchObject({ publishedAt: '2026-08-12T12:00:00.000Z', schemaVersion: 2, version: 'v0.46.0' })
    expect(manifest.components[1]?.pullRequests[0]).toMatchObject({ commitShas: [websiteSha], number: 1 })
    expect(manifest.components[1]?.pullRequests[0]).not.toHaveProperty('body')
    expect(serializePlatformReleaseManifest(manifest)).toContain(`"manifestDigest": "${manifest.manifestDigest}"`)
    expect(() => serializePlatformReleaseManifest({ ...manifest, summary: 'tampered' })).toThrow('digest mismatch')
  })
})

describe('release manifest v3', () => {
  it('keeps a native joint release distinct from silent application imports', () => {
    const manifest = createPlatformReleaseManifestV3({
      config, content, contentDigest: 'b'.repeat(64), plan,
      releases: {
        dashboard: { body: '', draft: true, id: 1, immutable: false, manifestAttached: false,
          platformPublishedAt: '2026-08-12T12:00:00.000Z', preparedAt: '2026-08-12T11:00:00Z',
          sha: dashboardSha, url: 'https://github.com/org/dashboard/releases/tag/v0.46.0' },
        website: { body: '', draft: true, id: 2, immutable: false, manifestAttached: false,
          platformPublishedAt: '2026-08-12T12:00:00.000Z', preparedAt: '2026-08-12T12:00:00Z',
          sha: websiteSha, url: 'https://github.com/org/website/releases/tag/v0.46.0' },
      },
      workflows: {
        dashboard: { conclusion: 'success', databaseId: 1, displayTitle: 'dashboard', status: 'completed', url: 'https://github.com/org/dashboard/actions/runs/1' },
        website: { conclusion: 'success', databaseId: 2, displayTitle: 'website', status: 'completed', url: 'https://github.com/org/website/actions/runs/2' },
      },
    })
    expect(manifest).toMatchObject({ notificationMode: 'standard', releaseMode: 'platform', schemaVersion: 3, source: { kind: 'native' } })
    expect(manifest.changes[0]).toMatchObject({ commitShas: [], componentKeys: ['website'] })
    expect(validateReleaseManifest(JSON.parse(serializeReleaseManifest(manifest)))).toEqual(manifest)
  })
})
