import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { canonicalJson, sha256 } from '../../src/platform-release/canonical.js'
import {
  buildReleaseImportManifest,
  createReleaseImportBatch,
  createReleaseImportPlans,
  ingestReleaseImportBatch,
  releaseImportContentDigest,
  releaseNotesPullRequests,
  reuseReleaseImportPlan,
  serializeReleaseImportManifest,
  validateReleaseImportContent,
  validateReleaseImportPlan,
} from '../../src/platform-release/import-release.js'
import type { PlatformReleaseConfig, ReleaseContentV3, ReleaseImportGitHubClient } from '../../src/platform-release/types.js'

const config: PlatformReleaseConfig = {
  founderOps: { baseUrl: 'https://founder-ops.findmydoc.eu', ingestPath: '/api/team/platform-releases/v1/releases' },
  platformBaselineVersion: 'v0.45.0',
  repositories: {
    dashboard: { branch: 'main', deploymentWorkflow: 'deploy.yml', displayName: 'Clinic Dashboard', productionUrl: 'https://clinics.findmydoc.eu', repository: 'findmydoc-platform/clinic-dashboard', surface: 'dashboard' },
    website: { branch: 'main', deploymentWorkflow: 'deploy.yml', displayName: 'Website', productionUrl: 'https://findmydoc.eu', repository: 'findmydoc-platform/website', surface: 'public' },
  },
  schemaVersion: 1,
}

const privateCommitPrefix = 'feat: release\n\nCo-authored-by: Example Person <person@example.com>\n\n'
const redactedCommitPrefix = 'feat: release\n\nCo-authored-by: Example Person <[redacted-email]>\n\n'
const boundaryPadding = 'x'.repeat(997 - redactedCommitPrefix.length)
const commits = [
  { bump: 'minor' as const, message: `${privateCommitPrefix}${boundaryPadding}😀suffix`, sha: 'a'.repeat(40), url: `https://github.com/findmydoc-platform/website/commit/${'a'.repeat(40)}` },
  { bump: 'patch' as const, message: 'fix: orphan', sha: 'b'.repeat(40), url: `https://github.com/findmydoc-platform/website/commit/${'b'.repeat(40)}` },
]

function github(body = 'See https://github.com/findmydoc-platform/website/pull/42'): ReleaseImportGitHubClient {
  return {
    compareCommits: vi.fn(async () => commits),
    getAllCommits: vi.fn(async () => commits),
    getPublishedReleases: vi.fn(async () => [{ body, publishedAt: '2026-07-01T10:00:00Z', releaseUrl: 'https://github.com/findmydoc-platform/website/releases/tag/v0.45.0', targetSha: 'a'.repeat(40), version: 'v0.45.0' }]),
    getPullRequests: vi.fn(async () => [{
      body: 'Contact person@example.com',
      commitShas: ['a'.repeat(40)],
      issues: [{ number: 41, repository: 'findmydoc-platform/website', title: `Issue for person@example.com ${'i'.repeat(500)}`, url: 'https://github.com/findmydoc-platform/website/issues/41' }],
      number: 42,
      repository: 'findmydoc-platform/website',
      title: `feat: release for person@example.com ${'p'.repeat(500)}`,
      url: 'https://github.com/findmydoc-platform/website/pull/42',
      visuals: [{ altText: 'Preview person@example.com', formFactor: 'desktop', label: 'Email person@example.com', pullRequestNumber: 42, releaseEligible: true, repository: 'findmydoc-platform/website', source: 'body', url: 'https://example.com/preview.png' }],
    }]),
  }
}

async function plan() {
  return (await createReleaseImportPlans({ componentKey: 'website', config, versions: ['v0.45.0'] }, github()))[0]!
}

function content(): ReleaseContentV3 {
  return {
    changes: [{
      commitShas: ['b'.repeat(40)],
      componentKeys: ['website'],
      id: 'website-release',
      kind: 'feature',
      pullRequests: [{ number: 42, repository: 'findmydoc-platform/website' }],
      summary: 'Die Website bündelt die veröffentlichten Verbesserungen.',
      title: 'Verbesserte Website',
      visualUrls: [],
    }],
    highlights: ['website-release'],
    reviewAcknowledgements: [],
    schemaVersion: 2,
    summary: 'Die Website bündelt die bis dahin veröffentlichten Verbesserungen.',
  }
}

describe('release import', () => {
  it('extracts explicit GitHub pull request references from release notes', () => {
    expect([...releaseNotesPullRequests('A https://github.com/findmydoc-platform/website/pull/42 and https://github.com/findmydoc-platform/website/pull/42')]).toEqual(['findmydoc-platform/website#42'])
  })

  it('plans a release from the exact tag range and flags notes discrepancies', async () => {
    const valid = await plan()
    expect(valid.reviewRequired).toEqual([])
    expect(valid.orphanCommits).toEqual(['b'.repeat(40)])
    expect(JSON.stringify(valid)).not.toMatch(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i)
    expect(valid.commits[0]?.message).toContain('[redacted-email]')
    expect(valid.pullRequests[0]).toMatchObject({
      body: 'Contact [redacted-email]',
      issues: [{ title: expect.stringContaining('Issue for [redacted-email]') }],
      title: expect.stringContaining('feat: release for [redacted-email]'),
      visuals: [{ altText: 'Preview [redacted-email]', label: 'Email [redacted-email]' }],
    })
    expect(validateReleaseImportPlan({ ...valid, createdAt: '2030-01-01T00:00:00.000Z' }, config).digest).toBe(valid.digest)
    expect(reuseReleaseImportPlan(valid, { ...valid, createdAt: '2030-01-01T00:00:00.000Z' }, config).createdAt).toBe(valid.createdAt)

    expect(() => validateReleaseImportPlan({ ...valid, releaseNotes: 'Contact person@example.com' }, config)).toThrow(
      'must not contain plain-text email addresses',
    )

    const legacyPlan = {
      ...valid,
      commits: valid.commits.map((commit, index) => index === 0
        ? { ...commit, message: `${privateCommitPrefix}${boundaryPadding}😀suffix` }
        : commit),
      digest: '',
    }
    expect(reuseReleaseImportPlan(legacyPlan, valid, config)).toMatchObject({
      createdAt: valid.createdAt,
      digest: valid.digest,
    })
    expect(JSON.stringify(reuseReleaseImportPlan(legacyPlan, valid, config))).not.toContain('person@example.com')

    const discrepant = (await createReleaseImportPlans({ componentKey: 'website', config, versions: ['v0.45.0'] }, github('No pull request link')))[0]!
    expect(discrepant.reviewRequired).toEqual(['Tag range contains findmydoc-platform/website#42, but the release notes do not reference it.'])
  })

  it('requires complete PR and orphan-commit attribution and creates a silent application manifest', async () => {
    const releasePlan = await plan()
    const approvedContent = validateReleaseImportContent(releasePlan, content())
    expect(releaseImportContentDigest(approvedContent)).toMatch(/^[a-f0-9]{64}$/)
    expect(releaseImportContentDigest({ summary: approvedContent.summary, schemaVersion: 2, reviewAcknowledgements: approvedContent.reviewAcknowledgements, highlights: approvedContent.highlights, changes: approvedContent.changes }))
      .toBe(releaseImportContentDigest(approvedContent))
    expect(() => validateReleaseImportContent(releasePlan, { ...content(), changes: [{ ...content().changes[0], commitShas: [] }] })).toThrow(/Every pull request and orphan commit/)

    const manifest = buildReleaseImportManifest(releasePlan, approvedContent, config)
    expect(manifest).toMatchObject({ notificationMode: 'silent', releaseMode: 'application', schemaVersion: 3, source: { kind: 'github-release-import' } })
    expect(manifest.publishedAt).toBe('2026-07-01T10:00:00Z')
    expect(manifest.components).toHaveLength(1)
    expect(manifest.components[0]?.commits[0]?.message).toHaveLength(1_000)
    expect(manifest.components[0]?.commits[0]?.message.endsWith('...')).toBe(true)
    expect(manifest.components[0]?.commits[0]?.message).toBe(`${redactedCommitPrefix}${boundaryPadding}...`)
    expect(manifest.components[0]?.pullRequests[0]?.title).toHaveLength(500)
    expect(manifest.components[0]?.pullRequests[0]?.issues[0]?.title).toHaveLength(500)
    expect(manifest.components[0]?.deploymentRun).toBeNull()
    expect(serializeReleaseImportManifest(manifest)).toContain('"schemaVersion": 3')
  })

  it('requires exact digest-bound acknowledgement of historical source discrepancies', async () => {
    const releasePlan = (await createReleaseImportPlans(
      { componentKey: 'website', config, versions: ['v0.45.0'] },
      github('Historical notes without a pull request link'),
    ))[0]!
    expect(releasePlan.reviewRequired).toHaveLength(1)
    expect(() => validateReleaseImportContent(releasePlan, content())).toThrow('acknowledge every exact plan review finding')
    const acknowledged = { ...content(), reviewAcknowledgements: [...releasePlan.reviewRequired] }
    expect(validateReleaseImportContent(releasePlan, acknowledged).reviewAcknowledgements).toEqual(releasePlan.reviewRequired)
    expect(buildReleaseImportManifest(releasePlan, acknowledged, config).source.kind).toBe('github-release-import')
  })

  it('ingests a confirmed batch in order and reuses stored manifests on replay', async () => {
    const releasePlan = await plan()
    const manifest = buildReleaseImportManifest(releasePlan, content(), config)
    const directory = await mkdtemp(join(tmpdir(), 'release-import-'))
    const releaseDirectory = join(directory, manifest.version)
    await import('node:fs/promises').then(({ mkdir }) => mkdir(releaseDirectory, { recursive: true }))
    await writeFile(join(releaseDirectory, 'platform-release.json'), serializeReleaseImportManifest(manifest), 'utf8')
    const batch = createReleaseImportBatch([{ manifestDigest: manifest.manifestDigest, manifestPath: `${manifest.version}/platform-release.json`, version: manifest.version }])
    const batchPath = join(directory, 'batch.json')
    await writeFile(batchPath, `${JSON.stringify(batch, null, 2)}\n`, 'utf8')
    const ingestManifest = vi.fn(async () => ({ replayed: true, url: `https://founder-ops.findmydoc.eu/team/platform-releases/${manifest.version}` }))
    const result = await ingestReleaseImportBatch({ apply: true, batchPath, config, confirmBatchDigest: batch.digest }, { ingestManifest })
    expect(result).toEqual([{ replayed: true, url: `https://founder-ops.findmydoc.eu/team/platform-releases/${manifest.version}`, version: manifest.version }])
    expect(ingestManifest).toHaveBeenCalledTimes(1)
  })

  it('validates every stored manifest before the first remote write', async () => {
    const releasePlan = await plan()
    const manifest = buildReleaseImportManifest(releasePlan, content(), config)
    const directory = await mkdtemp(join(tmpdir(), 'release-import-preflight-'))
    const validDirectory = join(directory, manifest.version)
    const invalidVersion = 'v0.44.0'
    const invalidDirectory = join(directory, invalidVersion)
    await import('node:fs/promises').then(({ mkdir }) => Promise.all([
      mkdir(validDirectory, { recursive: true }),
      mkdir(invalidDirectory, { recursive: true }),
    ]))
    await writeFile(join(validDirectory, 'platform-release.json'), serializeReleaseImportManifest(manifest), 'utf8')
    const { manifestDigest: _manifestDigest, ...invalidWithoutDigest } = {
      ...manifest,
      components: manifest.components.map((component) => ({
        ...component,
        commits: component.commits.map((commit, index) => index === 0 ? { ...commit, message: 'x'.repeat(1_001) } : commit),
      })),
      version: invalidVersion,
    }
    const invalidManifest = {
      ...invalidWithoutDigest,
      manifestDigest: sha256(canonicalJson(invalidWithoutDigest)),
    }
    await writeFile(join(invalidDirectory, 'platform-release.json'), canonicalJson(invalidManifest), 'utf8')
    const batch = createReleaseImportBatch([
      { manifestDigest: manifest.manifestDigest, manifestPath: `${manifest.version}/platform-release.json`, version: manifest.version },
      { manifestDigest: invalidManifest.manifestDigest, manifestPath: `${invalidVersion}/platform-release.json`, version: invalidVersion },
    ])
    const batchPath = join(directory, 'batch.json')
    await writeFile(batchPath, `${JSON.stringify(batch, null, 2)}\n`, 'utf8')
    const ingestManifest = vi.fn(async () => ({ replayed: false, url: 'https://founder-ops.findmydoc.eu/team/platform-releases/example' }))

    await expect(ingestReleaseImportBatch({ apply: true, batchPath, config, confirmBatchDigest: batch.digest }, { ingestManifest }))
      .rejects.toThrow()
    expect(ingestManifest).not.toHaveBeenCalled()
  })
})
