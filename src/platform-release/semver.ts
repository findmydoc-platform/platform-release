import type { ReleaseBump, ReleaseCommit } from './types.js'

const SEMVER_PATTERN = /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/
const CONVENTIONAL_COMMIT_PATTERN = /^(?<type>[a-z]+)(?:\([^\r\n)]+\))?(?<breaking>!)?:\s+/i

export function parseVersion(version: string): [number, number, number] {
  const match = version.match(SEMVER_PATTERN)
  if (!match) throw new Error(`Invalid semantic version: ${version}`)
  return [Number(match[1]), Number(match[2]), Number(match[3])]
}

export function compareVersions(left: string, right: string): number {
  const leftParts = parseVersion(left)
  const rightParts = parseVersion(right)
  for (let index = 0; index < 3; index += 1) {
    const difference = (leftParts[index] ?? 0) - (rightParts[index] ?? 0)
    if (difference !== 0) return difference
  }
  return 0
}

export function bumpForMessage(message: string): ReleaseBump {
  if (/^BREAKING[ -]CHANGE:\s+/im.test(message)) return 'major'
  const header = message.split(/\r?\n/, 1)[0] ?? ''
  const match = header.match(CONVENTIONAL_COMMIT_PATTERN)
  if (match?.groups?.breaking === '!') return 'major'
  if (match?.groups?.type?.toLowerCase() === 'feat') return 'minor'
  return 'patch'
}

export function highestBump(commits: ReleaseCommit[]): ReleaseBump {
  const bumps = new Set(commits.map((commit) => commit.bump))
  if (bumps.has('major')) return 'major'
  if (bumps.has('minor')) return 'minor'
  if (bumps.has('patch')) return 'patch'
  return 'none'
}

export function nextVersion(current: string, bump: ReleaseBump): string {
  const [major, minor, patch] = parseVersion(current)
  if (bump === 'major') return `v${major + 1}.0.0`
  if (bump === 'minor') return `v${major}.${minor + 1}.0`
  if (bump === 'patch') return `v${major}.${minor}.${patch + 1}`
  throw new Error('A release cannot be planned without changes in either application.')
}

export function assertManualVersion(version: string, current: string): void {
  if (compareVersions(version, current) <= 0) {
    throw new Error(`Manual version ${version} must be greater than ${current}.`)
  }
}
