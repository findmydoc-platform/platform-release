import type { ReleaseVisual } from './types.js'

type CandidateSource = ReleaseVisual['source']

function sectionBodies(markdown: string, sectionName: string): string[] {
  const bodies: string[] = []
  const lines = markdown.split('\n')
  let active: { level: number; lines: string[] } | undefined

  for (const line of lines) {
    const heading = line.match(/^(#{1,6})\s+(.+)$/)
    if (heading) {
      const level = heading[1]?.length ?? 0
      if (active && level <= active.level) {
        bodies.push(active.lines.join('\n'))
        active = undefined
      }
      const normalized = (heading[2] ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()
      if (!active && normalized === sectionName) active = { level, lines: [] }
      continue
    }
    active?.lines.push(line)
  }
  if (active) bodies.push(active.lines.join('\n'))
  return bodies
}

function markedBlocks(markdown: string): string[] {
  return [...markdown.matchAll(/<!--\s*gh-ui-screenshots:start\s*-->([\s\S]*?)<!--\s*gh-ui-screenshots:end\s*-->/gi)]
    .map((match) => match[1] ?? '')
}

function parseMetadata(beforeImage: string): Record<string, unknown> | undefined {
  const matches = [...beforeImage.matchAll(/<!--\s*gh-ui-screenshots:metadata\s+({[\s\S]*?})\s*-->/g)]
  const value = matches.at(-1)?.[1]
  if (!value) return undefined
  try {
    const parsed = JSON.parse(value) as unknown
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : undefined
  } catch {
    return undefined
  }
}

function extract(markdown: string, source: CandidateSource): Omit<ReleaseVisual, 'pullRequestNumber' | 'repository'>[] {
  const candidates: Omit<ReleaseVisual, 'pullRequestNumber' | 'repository'>[] = []
  const pattern = /!\[([^\]]*)\]\((https:\/\/[^\s)]+)(?:\s+"[^"]*")?\)/gi
  let match = pattern.exec(markdown)
  while (match) {
    const before = markdown.slice(0, match.index)
    const metadata = parseMetadata(before)
    const width = Number(metadata?.width)
    const formFactor = metadata?.formFactor === 'mobile' || metadata?.formFactor === 'tablet' || metadata?.formFactor === 'desktop'
      ? metadata.formFactor
      : Number.isFinite(width) && width <= 480
        ? 'mobile'
        : Number.isFinite(width) && width <= 900
          ? 'tablet'
          : 'desktop'
    const releaseRole = metadata?.releaseRole === 'primary' || metadata?.releaseRole === 'secondary'
      ? metadata.releaseRole
      : undefined
    const altText = (match[1] ?? '').trim()
    candidates.push({
      altText,
      formFactor,
      label: typeof metadata?.focusLabel === 'string' ? metadata.focusLabel : altText,
      releaseEligible: metadata?.releaseEligible === true,
      releaseRole,
      source,
      url: match[2] ?? '',
    })
    match = pattern.exec(markdown)
  }
  return candidates
}

export function extractReleaseVisuals(
  markdown: string,
  context: { pullRequestNumber: number; repository: string },
): ReleaseVisual[] {
  const candidates = [
    ...markedBlocks(markdown).flatMap((block) => extract(block, 'ui-ux-marker')),
    ...sectionBodies(markdown, 'ui ux').flatMap((body) => extract(body, 'ui-ux')),
    ...sectionBodies(markdown, 'screenshots').flatMap((body) => extract(body, 'screenshots')),
    ...extract(markdown, 'body'),
  ]
  const seen = new Set<string>()
  return candidates
    .filter((candidate) => {
      if (!candidate.url || seen.has(candidate.url)) return false
      seen.add(candidate.url)
      return true
    })
    .map((candidate) => ({ ...candidate, ...context }))
}

export function boundedVisualCandidates(visuals: ReleaseVisual[], maxCandidates = 12): ReleaseVisual[] {
  const byPullRequest = new Map<string, ReleaseVisual[]>()
  for (const visual of visuals) {
    const key = `${visual.repository}#${visual.pullRequestNumber}`
    const values = byPullRequest.get(key) ?? []
    values.push(visual)
    byPullRequest.set(key, values)
  }
  const pool = [...byPullRequest.values()].flatMap((values) => {
    const marked = values.filter((visual) => visual.releaseEligible && visual.releaseRole)
    return (marked.length > 0 ? marked : values).slice(0, 2)
  })
  return pool
    .sort((left, right) => {
      const role = (value: ReleaseVisual) => value.releaseRole === 'primary' ? 0 : value.releaseRole === 'secondary' ? 1 : 2
      return role(left) - role(right) || left.pullRequestNumber - right.pullRequestNumber
    })
    .slice(0, maxCandidates)
}
