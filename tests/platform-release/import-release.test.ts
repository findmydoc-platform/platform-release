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
  releaseImportContentTemplate,
  releaseNotesPullRequests,
  reuseReleaseImportPlan,
  serializeReleaseImportManifest,
  validateReleaseImportContent,
  validateReleaseImportManifestFilename,
  validateReleaseImportPlan,
} from '../../src/platform-release/import-release.js'
import { collectCommitEvidence, discoverReleasePullRequests, haveEquivalentCommitFiles, verifiedSquashMergePullRequestNumber } from '../../src/platform-release/github.js'
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
    compareReleaseCommits: vi.fn(async () => ({ commits, mergeBaseSha: 'c'.repeat(40), status: 'ahead' })),
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
  it('recovers only an exact verified squash-merge pull request reference', () => {
    const commit = { message: 'feat: historical release change (#123)\n\nDetails', sha: 'a'.repeat(40) }
    const pullRequest = { merge_commit_sha: commit.sha, merged_at: '2025-01-01T00:00:00Z', number: 123, title: 'feat: historical release change' }

    expect(verifiedSquashMergePullRequestNumber(commit, pullRequest)).toBe(123)
    expect(verifiedSquashMergePullRequestNumber(commit, { ...pullRequest, merge_commit_sha: 'b'.repeat(40) })).toBeUndefined()
    expect(verifiedSquashMergePullRequestNumber(commit, { ...pullRequest, merge_commit_sha: 'b'.repeat(40) }, true, commit.message)).toBe(123)
    expect(verifiedSquashMergePullRequestNumber(commit, { ...pullRequest, merge_commit_sha: 'b'.repeat(40) }, true, 'feat: changed title (#123)')).toBeUndefined()
    expect(verifiedSquashMergePullRequestNumber(commit, { ...pullRequest, merged_at: null })).toBeUndefined()
    expect(verifiedSquashMergePullRequestNumber(commit, { ...pullRequest, number: 124 })).toBeUndefined()
    expect(verifiedSquashMergePullRequestNumber({ ...commit, message: 'feat: untrusted reference #123' }, pullRequest)).toBeUndefined()
    expect(verifiedSquashMergePullRequestNumber(commit, { ...pullRequest, title: 'mutable current title' })).toBe(123)

    const files = [{ filename: 'src/example.ts', sha: 'c'.repeat(40), status: 'modified' }]
    expect(haveEquivalentCommitFiles(files, [...files])).toBe(true)
    expect(haveEquivalentCommitFiles(files, [{ ...files[0]!, sha: 'd'.repeat(40) }])).toBe(false)
    expect(haveEquivalentCommitFiles([], [])).toBe(false)
  })

  it('collects complete paginated commit evidence and fails closed at the GitHub file limit', async () => {
    const file = (index: number) => ({ filename: `src/${index}.ts`, sha: index.toString().padStart(40, '0'), status: 'modified' })
    const completeFetch = vi.fn(async (page: number) => ({
      commit: { message: 'feat: release (#123)' },
      files: page === 1 ? Array.from({ length: 100 }, (_, index) => file(index)) : [file(100)],
    }))
    const complete = await collectCommitEvidence(completeFetch)
    expect(complete).toMatchObject({ complete: true, message: 'feat: release (#123)' })
    expect(complete.files).toHaveLength(101)
    expect(completeFetch).toHaveBeenNthCalledWith(1, 1, 100)
    expect(completeFetch).toHaveBeenNthCalledWith(2, 2, 100)

    const limitedFetch = vi.fn(async (page: number) => ({
      commit: { message: 'feat: release (#123)' },
      files: Array.from({ length: 100 }, (_, index) => file(((page - 1) * 100) + index)),
    }))
    const limited = await collectCommitEvidence(limitedFetch)
    expect(limited).toMatchObject({ complete: false })
    expect(limited.files).toHaveLength(3_000)
    expect(limitedFetch).toHaveBeenCalledTimes(30)
  })

  it('recovers a verified squash merge through the complete discovery path', async () => {
    const commit = { bump: 'minor' as const, message: 'feat: historical release change (#123)', sha: 'a'.repeat(40), url: 'https://github.com/org/repo/commit/a' }
    const getPullRequest = vi.fn(async () => ({
      body: '## What changed\n\nHistorical change.',
      html_url: 'https://github.com/org/repo/pull/123',
      merge_commit_sha: 'b'.repeat(40),
      merged_at: '2025-01-01T00:00:00Z',
      number: 123,
      title: 'feat: historical release change',
    }))
    const getCommitEvidence = vi.fn(async (sha: string) => ({
      complete: true,
      files: [{ filename: 'src/example.ts', sha: 'c'.repeat(40), status: 'modified' }],
      message: `feat: historical release change (#123)\n\n${sha}`,
    }))
    const result = await discoverReleasePullRequests({
      commits: [commit],
      getAssociatedPullRequestNumbers: vi.fn(async () => []),
      getClosingIssues: vi.fn(async () => []),
      getCommitEvidence,
      getPullRequest,
      repository: 'org/repo',
    })

    expect(result).toMatchObject([{ commitShas: [commit.sha], number: 123, repository: 'org/repo' }])
    expect(getPullRequest).toHaveBeenCalledTimes(1)
    expect(result[0]?.number).toBe(123)
    expect(getCommitEvidence.mock.calls.map(([sha]) => sha)).toEqual([commit.sha, 'b'.repeat(40)])
  })

  it('keeps an unavailable squash reference orphaned and propagates other lookup errors', async () => {
    const commit = { bump: 'minor' as const, message: 'feat: historical release change (#123)', sha: 'a'.repeat(40), url: 'https://github.com/org/repo/commit/a' }
    const base = {
      commits: [commit],
      getAssociatedPullRequestNumbers: vi.fn(async () => []),
      getClosingIssues: vi.fn(async () => []),
      getCommitEvidence: vi.fn(async () => ({ complete: true, files: [], message: commit.message })),
      repository: 'org/repo',
    }

    await expect(discoverReleasePullRequests({ ...base, getPullRequest: vi.fn(async () => undefined) })).resolves.toEqual([])
    await expect(discoverReleasePullRequests({
      ...base,
      getPullRequest: vi.fn(async () => { throw new Error('GitHub unavailable') }),
    })).rejects.toThrow('GitHub unavailable')
  })

  it('extracts explicit GitHub pull request references from release notes', () => {
    expect([...releaseNotesPullRequests('A https://github.com/findmydoc-platform/website/pull/42 and https://github.com/findmydoc-platform/website/pull/42')]).toEqual(['findmydoc-platform/website#42'])
  })

  it('accepts only safe append-only import manifest filenames', () => {
    expect(validateReleaseImportManifestFilename('platform-release.json')).toBe('platform-release.json')
    expect(validateReleaseImportManifestFilename('platform-release-retry-1.json')).toBe('platform-release-retry-1.json')
    expect(() => validateReleaseImportManifestFilename('../platform-release.json')).toThrow('lowercase hyphenated variant')
    expect(() => validateReleaseImportManifestFilename('platform-release-Retry.json')).toThrow('lowercase hyphenated variant')
  })

  it('plans a release from the exact tag range and flags notes discrepancies', async () => {
    const valid = await plan()
    expect(valid.schemaVersion).toBe(2)
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

    const { range: _range, ...legacyV1WithoutRange } = valid
    const legacyV1 = { ...legacyV1WithoutRange, schemaVersion: 1 as const, digest: '' }
    legacyV1.digest = sha256(canonicalJson((({ createdAt: _createdAt, digest: _ignored, ...durable }) => durable)(legacyV1)))
    expect(validateReleaseImportPlan(JSON.parse(JSON.stringify(legacyV1)), config)).toMatchObject({ schemaVersion: 1 })
    expect(reuseReleaseImportPlan(legacyV1, valid, config)).toEqual(legacyV1)

    const discrepant = (await createReleaseImportPlans({ componentKey: 'website', config, versions: ['v0.45.0'] }, github('No pull request link')))[0]!
    expect(discrepant.reviewRequired).toEqual(['Tag range contains findmydoc-platform/website#42, but the release notes do not reference it.'])
  })

  it('plans and builds a reviewed release when adjacent tags point to the same commit', async () => {
    const targetSha = 'c'.repeat(40)
    const notes = 'See https://github.com/findmydoc-platform/website/pull/236'
    const identicalGithub: ReleaseImportGitHubClient = {
      compareReleaseCommits: vi.fn(async () => ({ commits: [], mergeBaseSha: targetSha, status: 'identical' })),
      getAllCommits: vi.fn(async () => []),
      getPublishedReleases: vi.fn(async () => [
        { body: notes, publishedAt: '2025-07-04T14:57:53Z', releaseUrl: 'https://github.com/findmydoc-platform/website/releases/tag/v0.7.5', targetSha, version: 'v0.7.5' },
        { body: notes, publishedAt: '2025-07-06T21:43:46Z', releaseUrl: 'https://github.com/findmydoc-platform/website/releases/tag/v0.8.0', targetSha, version: 'v0.8.0' },
      ]),
      getPullRequests: vi.fn(async () => []),
    }
    const releasePlan = (await createReleaseImportPlans(
      { componentKey: 'website', config, versions: ['v0.8.0'] },
      identicalGithub,
    ))[0]!

    expect(releasePlan.commits).toEqual([])
    expect(releasePlan.reviewRequired).toEqual([
      'Release tag v0.8.0 points to the same commit as previous release v0.7.5; no unique commit range exists.',
      'Release notes reference findmydoc-platform/website#236, but the tag range does not.',
    ])
    const template = releaseImportContentTemplate(releasePlan)
    const approvedContent = {
      ...template,
      changes: template.changes.map((change) => ({
        ...change,
        summary: 'Die veröffentlichte Version verwendet denselben Code-Stand wie die vorherige Version.',
        title: 'Dokumentierter Versionsstand',
      })),
      reviewAcknowledgements: [...releasePlan.reviewRequired],
      summary: 'Die Website dokumentiert einen weiteren veröffentlichten Versionsstand ohne eigenen Commit-Bereich.',
    }
    expect(validateReleaseImportContent(releasePlan, approvedContent).changes[0]).toMatchObject({
      commitShas: [],
      pullRequests: [],
    })
    expect(buildReleaseImportManifest(releasePlan, approvedContent, config).components[0]?.commits).toEqual([])

    const { digest: _digest, range: _range, ...unboundPlan } = releasePlan
    const invalidPlan = {
      ...unboundPlan,
      digest: '',
      schemaVersion: 2 as const,
      range: { kind: 'commits' as const, previousTargetSha: 'd'.repeat(40) },
    }
    invalidPlan.digest = sha256(canonicalJson((({ createdAt: _createdAt, digest: _ignored, ...durable }) => durable)(invalidPlan)))
    expect(() => validateReleaseImportPlan(invalidPlan, config)).toThrow('Commit release import range is invalid')
    expect(() => validateReleaseImportContent(invalidPlan, approvedContent)).toThrow('Commit release import range is invalid')
  })

  it('binds a diverged historical release range and its acknowledgement into the plan', async () => {
    const baseSha = 'c'.repeat(40)
    const targetSha = 'd'.repeat(40)
    const mergeBaseSha = 'e'.repeat(40)
    const divergedGithub: ReleaseImportGitHubClient = {
      compareReleaseCommits: vi.fn(async () => ({ commits, mergeBaseSha, status: 'diverged' })),
      getAllCommits: vi.fn(async () => []),
      getPublishedReleases: vi.fn(async () => [
        { body: '', publishedAt: '2025-06-26T21:23:37Z', releaseUrl: 'https://github.com/findmydoc-platform/website/releases/tag/v0.6.1', targetSha: baseSha, version: 'v0.6.1' },
        { body: 'See https://github.com/findmydoc-platform/website/pull/42', publishedAt: '2025-07-04T05:37:31Z', releaseUrl: 'https://github.com/findmydoc-platform/website/releases/tag/v0.7.0', targetSha, version: 'v0.7.0' },
      ]),
      getPullRequests: github().getPullRequests,
    }
    const releasePlan = (await createReleaseImportPlans(
      { componentKey: 'website', config, versions: ['v0.7.0'] },
      divergedGithub,
    ))[0]!

    expect(releasePlan.range).toEqual({ kind: 'diverged', mergeBaseSha, previousTargetSha: baseSha })
    expect(releasePlan.reviewRequired).toContain(
      `Release tag v0.7.0 diverges from previous release v0.6.1 at merge base ${mergeBaseSha}; the plan contains only commits unique to v0.7.0.`,
    )
    expect(() => validateReleaseImportContent(releasePlan, content())).toThrow('acknowledge every exact plan review finding')
    expect(validateReleaseImportContent(releasePlan, {
      ...content(),
      reviewAcknowledgements: [...releasePlan.reviewRequired],
    }).reviewAcknowledgements).toEqual(releasePlan.reviewRequired)
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

    const { manifestDigest: _secondManifestDigest, ...invalidTitleWithoutDigest } = {
      ...manifest,
      components: manifest.components.map((component) => ({
        ...component,
        pullRequests: component.pullRequests.map((pullRequest, index) => index === 0 ? { ...pullRequest, title: 42 } : pullRequest),
      })),
      version: invalidVersion,
    }
    const invalidTitleManifest = {
      ...invalidTitleWithoutDigest,
      manifestDigest: sha256(canonicalJson(invalidTitleWithoutDigest)),
    }
    await writeFile(join(invalidDirectory, 'platform-release.json'), canonicalJson(invalidTitleManifest), 'utf8')
    const invalidTitleBatch = createReleaseImportBatch([
      { manifestDigest: manifest.manifestDigest, manifestPath: `${manifest.version}/platform-release.json`, version: manifest.version },
      { manifestDigest: invalidTitleManifest.manifestDigest, manifestPath: `${invalidVersion}/platform-release.json`, version: invalidVersion },
    ])
    await writeFile(batchPath, `${JSON.stringify(invalidTitleBatch, null, 2)}\n`, 'utf8')

    await expect(ingestReleaseImportBatch({ apply: true, batchPath, config, confirmBatchDigest: invalidTitleBatch.digest }, { ingestManifest }))
      .rejects.toThrow()
    expect(ingestManifest).not.toHaveBeenCalled()
  })
})
