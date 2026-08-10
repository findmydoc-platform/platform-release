import { describe, expect, it } from 'vitest'
import { bumpForMessage, highestBump, nextVersion } from '../../src/platform-release/semver.js'

describe('platform release semantic versioning', () => {
  it('uses feat for minor and every other non-breaking commit for patch', () => {
    expect(bumpForMessage('feat(reviews): add moderation')).toBe('minor')
    expect(bumpForMessage('fix: correct review totals')).toBe('patch')
    expect(bumpForMessage('Update copy without a conventional header')).toBe('patch')
  })

  it('detects breaking headers and footers', () => {
    expect(bumpForMessage('feat!: replace clinic contract')).toBe('major')
    expect(bumpForMessage('refactor: reshape contract\n\nBREAKING CHANGE: clients must migrate')).toBe('major')
  })

  it('selects the highest bump across both applications', () => {
    expect(highestBump([
      { bump: 'patch', message: 'fix: one', sha: 'a', url: 'https://example.test/a' },
      { bump: 'minor', message: 'feat: two', sha: 'b', url: 'https://example.test/b' },
    ])).toBe('minor')
    expect(nextVersion('v0.45.0', 'minor')).toBe('v0.46.0')
    expect(nextVersion('v0.45.0', 'patch')).toBe('v0.45.1')
  })
})
