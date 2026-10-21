import { describe, expect, it } from 'vitest'
import {
  computeReleaseContentDigest,
  releaseContentTemplate,
  renderRepositoryReleaseNotes,
  renderReleaseContentPreview,
  validateReleaseContent,
} from '../../src/platform-release/content.js'
import type { PlatformReleaseContent, PlatformReleasePlan } from '../../src/platform-release/types.js'

const plan = {
  digest: 'a'.repeat(64),
  repositories: {
    dashboard: { pullRequests: [{ number: 2, repository: 'org/dashboard', title: 'Moderation', url: 'https://github.com/org/dashboard/pull/2' }] },
    website: { pullRequests: [{ number: 1, repository: 'org/website', title: 'Reviews', url: 'https://github.com/org/website/pull/1' }] },
  },
  version: 'v0.46.0',
  visualCandidates: [{ altText: 'Review page', formFactor: 'desktop', label: 'Reviews', pullRequestNumber: 1,
    releaseEligible: true, repository: 'org/website', source: 'screenshots', url: 'https://example.test/reviews.png' }],
} as unknown as PlatformReleasePlan

function content(): PlatformReleaseContent {
  return {
    changes: [{
      id: 'reviews', kind: 'feature', pullRequests: [
        { number: 1, repository: 'org/website' }, { number: 2, repository: 'org/dashboard' },
      ], section: 'platform', summary: 'Bewertungen werden durchgängig dargestellt und moderiert.',
      title: 'Bewertungen', visualUrls: ['https://example.test/reviews.png'],
    }],
    highlights: ['reviews'], schemaVersion: 1,
    summary: 'Bewertungen verbinden jetzt Website und Clinic Dashboard.',
  }
}

describe('structured release content', () => {
  it('keeps the generated template invalid until editorial text is supplied', () => {
    const template = releaseContentTemplate(plan)
    expect(template.highlights).toEqual([])
    expect(() => validateReleaseContent(plan, template)).toThrow()
  })

  it('accepts one cross-cutting change that owns both pull requests', () => {
    expect(validateReleaseContent(plan, content())).toEqual(content())
  })

  it('validates and digest-binds compact titles without changing legacy content', () => {
    const legacy = { ...content(), summary: 'a'.repeat(280), changes: [{ ...content().changes[0]!, title: 'a'.repeat(120) }] }
    expect(validateReleaseContent(plan, legacy)).toEqual(legacy)
    expect(validateReleaseContent(plan, legacy)).not.toHaveProperty('title')
    const titled = { ...content(), title: 'Klinikgruppen im Dashboard vorbereitet' }
    expect(validateReleaseContent(plan, titled)).toEqual(titled)
    expect(computeReleaseContentDigest(titled)).not.toBe(computeReleaseContentDigest(content()))
    expect(renderReleaseContentPreview(titled)).toContain(`${titled.title}\n\n${titled.summary}`)
    expect(releaseContentTemplate(plan)).toHaveProperty('title', '')
    for (const title of ['', '   ', 'a\nb', '\nKlinikgruppen', 'a'.repeat(66), null]) {
      expect(() => validateReleaseContent(plan, { ...content(), title })).toThrow('Release title')
    }
    expect(() => validateReleaseContent(plan, { ...titled, summary: 'a'.repeat(161) })).toThrow('Release summary')
    expect(() => validateReleaseContent(plan, { ...titled, changes: legacy.changes })).toThrow('title')
    for (const title of ['', '\nBewertungen', 'a\nb', 'a'.repeat(66)]) {
      expect(() => validateReleaseContent(plan, { ...titled, changes: [{ ...content().changes[0]!, title }] })).toThrow('title')
    }
    expect(validateReleaseContent(plan, { ...titled, title: 'a'.repeat(65), summary: 'a'.repeat(160), changes: [{ ...content().changes[0]!, title: 'a'.repeat(65) }] })).toBeDefined()
  })

  it('rejects missing and duplicate pull request assignments', () => {
    const missing = content()
    missing.changes[0]!.pullRequests.pop()
    expect(() => validateReleaseContent(plan, missing)).toThrow('Missing: org/dashboard#2')

    const duplicate = content()
    duplicate.changes.push({ ...duplicate.changes[0]!, id: 'reviews-copy', visualUrls: [] })
    expect(() => validateReleaseContent(plan, duplicate)).toThrow('assigned more than once')
  })

  it('rejects invalid highlights, sections, ids and unrelated visuals', () => {
    expect(() => validateReleaseContent(plan, { ...content(), highlights: ['missing'] })).toThrow('Invalid highlight')
    const invalidSection = content() as unknown as { changes: Array<Record<string, unknown>> }
    invalidSection.changes[0]!.section = 'backend'
    expect(() => validateReleaseContent(plan, invalidSection)).toThrow('Invalid section')
    const invalidId = content()
    invalidId.changes[0]!.id = 'Reviews!'
    expect(() => validateReleaseContent(plan, invalidId)).toThrow('kebab-case')
    const unrelated = content()
    unrelated.changes[0]!.pullRequests = [{ number: 2, repository: 'org/dashboard' }]
    expect(() => validateReleaseContent(plan, unrelated)).toThrow('must belong to a pull request')
  })

  it('computes the same digest regardless of JSON key order', () => {
    const approved = content()
    const reordered = {
      summary: approved.summary,
      schemaVersion: approved.schemaVersion,
      highlights: approved.highlights,
      changes: approved.changes.map((change) => ({
        visualUrls: change.visualUrls, title: change.title, summary: change.summary, section: change.section,
        pullRequests: change.pullRequests.map((pullRequest) => ({ repository: pullRequest.repository, number: pullRequest.number })),
        kind: change.kind, id: change.id,
      })),
    } as PlatformReleaseContent
    expect(computeReleaseContentDigest(approved)).toBe(computeReleaseContentDigest(reordered))
  })

  it('renders deterministic German notes without visible English heading checks', () => {
    const notes = renderRepositoryReleaseNotes(plan, content(), 'website')
    expect(notes).toContain('## Plattformweit')
    expect(notes).toContain('## Technische Referenzen')
    expect(notes).not.toContain('## Platform release')
  })

  it('validates and digest-binds both English introductions without changing the product narrative', () => {
    const approved = {
      ...content(),
      githubSummaries: {
        dashboard: 'This release adds review moderation to Clinic Dashboard.',
        website: 'This release adds patient reviews to the website.',
      },
    }
    expect(validateReleaseContent(plan, approved)).toEqual(approved)
    expect(releaseContentTemplate(plan).githubSummaries).toEqual({ dashboard: '', website: '' })
    expect(computeReleaseContentDigest(approved)).not.toBe(
      computeReleaseContentDigest({
        ...approved,
        githubSummaries: { ...approved.githubSummaries, website: 'This release fixes review rendering.' },
      }),
    )
    expect(() => validateReleaseContent(plan, { ...approved, githubSummaries: { website: 'Only one repo.' } })).toThrow(
      'exactly',
    )
    expect(() =>
      validateReleaseContent(plan, { ...approved, githubSummaries: { ...approved.githubSummaries, website: '' } }),
    ).toThrow('Website GitHub summary')
    expect(validateReleaseContent(plan, content())).not.toHaveProperty('githubSummaries')
    expect(approved.summary).toBe(content().summary)
  })

  it('renders native-style English notes scoped to the repo, including only uncovered commits', () => {
    const nativePlan = structuredClone(plan)
    const covered = 'b'.repeat(40)
    const orphan = 'c'.repeat(40)
    nativePlan.repositories.website = {
      ...nativePlan.repositories.website,
      repository: 'org/website',
      base: { kind: 'release', version: 'v0.45.0', sha: 'a'.repeat(40) },
      commits: [
        {
          sha: covered,
          bump: 'minor',
          message: 'feat: reviews',
          url: `https://github.com/org/website/commit/${covered}`,
        },
        {
          sha: orphan,
          bump: 'patch',
          message: 'fix: review cache\nAdditional commit detail',
          url: `https://github.com/org/website/commit/${orphan}`,
        },
      ],
      pullRequests: [
        { ...nativePlan.repositories.website.pullRequests[0]!, title: 'feat: patient reviews', commitShas: [covered] },
      ],
    }
    const approved = {
      ...content(),
      githubSummaries: {
        dashboard: 'This release adds moderation.',
        website: 'This release adds patient reviews and fixes stale review caches.',
      },
    }
    const notes = renderRepositoryReleaseNotes(nativePlan, approved, 'website')
    expect(notes).toBe(
      `This release adds patient reviews and fixes stale review caches.\n\n## What's Changed\n\n* feat: patient reviews in [#1](https://github.com/org/website/pull/1)\n* fix: review cache in [ccccccc](https://github.com/org/website/commit/${orphan})\n\n**Full Changelog:** https://github.com/org/website/compare/v0.45.0...v0.46.0\n\nPlatform-Plan: \`${plan.digest}\``,
    )
    expect(notes).not.toContain(covered)
    expect(notes).not.toContain('org/dashboard')
    expect(notes).not.toContain(approved.summary)
    nativePlan.repositories.website = {
      ...nativePlan.repositories.website,
      base: { kind: 'cutover', sha: 'd'.repeat(40) },
      commits: [],
      pullRequests: [],
    }
    const unchanged = renderRepositoryReleaseNotes(nativePlan, approved, 'website')
    expect(unchanged).toContain('No component-specific source changes')
    expect(unchanged).toContain(`/compare/${'d'.repeat(40)}...v0.46.0`)
  })
})
