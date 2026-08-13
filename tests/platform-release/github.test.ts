import { describe, expect, it } from 'vitest'
import { assertMatchingReleaseManifest, githubChildEnvironment } from '../../src/platform-release/github.js'

describe('GitHub release manifest resume', () => {
  it('accepts byte-identical assets and rejects different existing content', () => {
    expect(() => assertMatchingReleaseManifest('{"same":true}\n', '{"same":true}\n', 'org/repo', 'v0.46.0')).not.toThrow()
    expect(() => assertMatchingReleaseManifest('{"old":true}\n', '{"new":true}\n', 'org/repo', 'v0.46.0'))
      .toThrow('already has a different platform-release.json')
  })

  it('preserves cross-platform GitHub CLI configuration without forwarding unrelated secrets', () => {
    expect(githubChildEnvironment({
      APPDATA: 'windows-config',
      GH_TOKEN: 'github-token',
      HOME: 'unix-home',
      PATH: 'commands',
      SystemRoot: 'windows-root',
      UNRELATED_SECRET: 'must-not-pass',
      USERPROFILE: 'windows-home',
    })).toEqual({
      APPDATA: 'windows-config',
      GH_TOKEN: 'github-token',
      HOME: 'unix-home',
      PATH: 'commands',
      SystemRoot: 'windows-root',
      USERPROFILE: 'windows-home',
    })
  })
})
