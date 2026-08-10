import { describe, expect, it } from 'vitest'
import { releaseNotesTemplate, validateReleaseNotes } from '../../src/platform-release/notes.js'
import type { PlatformReleasePlan } from '../../src/platform-release/types.js'

const plan = {
  digest: 'a'.repeat(64),
  highestBump: 'patch',
  manualVersion: false,
  repositories: {
    dashboard: { pullRequests: [], surface: 'Dashboard for clinics' },
    website: { pullRequests: [], surface: 'Public platform' },
  },
  version: 'v0.46.0',
} as unknown as PlatformReleasePlan

describe('release note approval', () => {
  it('rejects the untouched drafting template', () => {
    expect(() => validateReleaseNotes(releaseNotesTemplate(plan))).toThrow(
      'reviewed content under "## Platform release"',
    )
  })

  it('requires reviewed content for every public section', () => {
    expect(() => validateReleaseNotes([
      '## Platform release',
      'One coordinated capability.',
      '## Dashboard for clinics',
      '<!-- still empty -->',
      '## Public platform',
      'Public experience updated.',
    ].join('\n'))).toThrow('reviewed content under "## Dashboard for clinics"')
  })

  it('accepts explicitly reviewed release notes', () => {
    expect(() => validateReleaseNotes([
      '## Platform release',
      'One coordinated capability.',
      '## Dashboard for clinics',
      'No standalone dashboard changes.',
      '## Public platform',
      'Public experience updated.',
    ].join('\n'))).not.toThrow()
  })
})
