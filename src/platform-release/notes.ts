import type { PlatformReleasePlan, PlatformRepositoryKey, ReleaseVisual } from './types.js'

const REQUIRED_HEADINGS = [
  '## Platform release',
  '## Dashboard for clinics',
  '## Public platform',
]

export function validateReleaseNotes(notes: string): void {
  if (!notes.trim()) throw new Error('Approved release notes are empty.')
  for (const heading of REQUIRED_HEADINGS) {
    if (!notes.includes(heading)) throw new Error(`Approved release notes must include "${heading}".`)
  }
}

export function approvedReleaseVisuals(plan: PlatformReleasePlan, notes: string): ReleaseVisual[] {
  const urls = [...notes.matchAll(/<!--\s*platform-release:visual\s+(https:\/\/\S+)\s*-->/g)]
    .map((match) => match[1] ?? '')
  if (urls.length > 4) throw new Error('Approved release notes can select at most four visuals.')
  const candidates = new Map(plan.visualCandidates.map((visual) => [visual.url, visual]))
  return urls.map((url) => {
    const visual = candidates.get(url)
    if (!visual) throw new Error(`Approved visual is not part of the frozen plan: ${url}`)
    return visual
  })
}

export function renderRepositoryReleaseNotes(
  plan: PlatformReleasePlan,
  notes: string,
  key: PlatformRepositoryKey,
): string {
  const repository = plan.repositories[key]
  const pullRequests = repository.pullRequests.map((pullRequest) =>
    `- [#${pullRequest.number}](${pullRequest.url}) ${pullRequest.title}`)
  const commitLines = repository.pullRequests.length === 0 ? repository.commits.map((commit) =>
    `- [${commit.sha.slice(0, 7)}](${commit.url}) ${commit.message.split(/\r?\n/, 1)[0] ?? ''}`)
    : []
  const appendix = [...pullRequests, ...commitLines]
  return [
    `# findmydoc ${plan.version}`,
    '',
    notes.trim(),
    '',
    `## Technical appendix: ${repository.surface}`,
    '',
    ...(appendix.length > 0 ? appendix : ['- No application-specific commits in this release range.']),
    '',
    `Platform plan: \`${plan.digest}\``,
  ].join('\n')
}

export function releaseNotesTemplate(plan: PlatformReleasePlan): string {
  const topicHints = Object.values(plan.repositories).flatMap((repository) =>
    repository.pullRequests.map((pullRequest) => `- ${repository.surface}: ${pullRequest.title} (${pullRequest.url})`))
  return [
    `# Draft notes for findmydoc ${plan.version}`,
    '',
    '## Platform release',
    '',
    '<!-- Group shared business capabilities once. Use surface sub-points when a topic spans both applications. -->',
    '',
    '## Dashboard for clinics',
    '',
    '<!-- Clinic-facing capabilities that are not already covered above. -->',
    '',
    '## Public platform',
    '',
    '<!-- Public-facing capabilities that are not already covered above. -->',
    '',
    '## Source hints',
    '',
    ...topicHints,
    '',
  ].join('\n')
}
