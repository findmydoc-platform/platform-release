import { describe, expect, it } from 'vitest'
import {
  computeReleaseContentDigest,
  releaseContentTemplate,
  renderRepositoryReleaseNotes,
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
    expect(() => validateReleaseContent(plan, releaseContentTemplate(plan))).toThrow('Release summary')
  })

  it('accepts one cross-cutting change that owns both pull requests', () => {
    expect(validateReleaseContent(plan, content())).toEqual(content())
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
})
