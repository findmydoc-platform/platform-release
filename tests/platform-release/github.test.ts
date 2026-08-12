import { describe, expect, it } from 'vitest'
import { assertMatchingReleaseManifest } from '../../src/platform-release/github.js'

describe('GitHub release manifest resume', () => {
  it('accepts byte-identical assets and rejects different existing content', () => {
    expect(() => assertMatchingReleaseManifest('{"same":true}\n', '{"same":true}\n', 'org/repo', 'v0.46.0')).not.toThrow()
    expect(() => assertMatchingReleaseManifest('{"old":true}\n', '{"new":true}\n', 'org/repo', 'v0.46.0'))
      .toThrow('already has a different platform-release.json')
  })
})
