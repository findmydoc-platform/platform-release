import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { canonicalJson, sha256 } from './canonical.js'
import type {
  PlatformReleaseContent,
  PlatformReleasePlan,
  PlatformRepositoryKey,
  ReleaseContentChange,
  ReleaseContentKind,
  ReleaseContentSection,
  ReleaseVisual,
} from './types.js'

const CHANGE_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
const REPOSITORY_KEYS: PlatformRepositoryKey[] = ['dashboard', 'website']
const SECTIONS = new Set<ReleaseContentSection>(['dashboard', 'platform', 'public'])
const KINDS = new Set<ReleaseContentKind>(['feature', 'fix', 'maintenance'])

function requireObject(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object.`)
  return value as Record<string, unknown>
}

function requireExactKeys(value: Record<string, unknown>, keys: string[], label: string): void {
  const actual = Object.keys(value).sort()
  const expected = [...keys].sort()
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${label} must contain exactly: ${expected.join(', ')}.`)
  }
}

function requireEditorialText(value: unknown, label: string, maximum: number): string {
  if (typeof value !== 'string') throw new Error(`${label} must be a string.`)
  const text = value.trim()
  if (!text || text.length > maximum || /[\r\n]/.test(text)) {
    throw new Error(`${label} must be one non-empty line with at most ${maximum} characters.`)
  }
  return text
}

function pullRequestKey(repository: string, number: number): string {
  return `${repository}#${number}`
}

export function validateReleaseContent(
  plan: PlatformReleasePlan,
  candidate: unknown,
): PlatformReleaseContent {
  const value = requireObject(candidate, 'Release content')
  requireExactKeys(value, ['changes', 'highlights', 'schemaVersion', 'summary'], 'Release content')
  if (value.schemaVersion !== 1) throw new Error('Unsupported release content schema.')
  const summary = requireEditorialText(value.summary, 'Release summary', 280)
  if (!Array.isArray(value.changes) || value.changes.length === 0) {
    throw new Error('Release content must contain at least one change.')
  }

  const plannedPullRequests = new Map<string, { repository: string; number: number }>()
  for (const key of REPOSITORY_KEYS) {
    for (const pullRequest of plan.repositories[key].pullRequests) {
      plannedPullRequests.set(pullRequestKey(pullRequest.repository, pullRequest.number), {
        number: pullRequest.number,
        repository: pullRequest.repository,
      })
    }
  }
  const visualCandidates = new Map(plan.visualCandidates.map((visual) => [visual.url, visual]))
  const assignedPullRequests = new Set<string>()
  const selectedVisualUrls = new Set<string>()
  const ids = new Set<string>()

  const changes = value.changes.map((entry, index): ReleaseContentChange => {
    const change = requireObject(entry, `Change ${index + 1}`)
    requireExactKeys(change, ['id', 'kind', 'pullRequests', 'section', 'summary', 'title', 'visualUrls'], `Change ${index + 1}`)
    const id = requireEditorialText(change.id, `Change ${index + 1} id`, 80)
    if (!CHANGE_ID.test(id)) throw new Error(`Change id must be a lowercase kebab-case identifier: ${id}.`)
    if (ids.has(id)) throw new Error(`Duplicate change id: ${id}.`)
    ids.add(id)
    if (typeof change.section !== 'string' || !SECTIONS.has(change.section as ReleaseContentSection)) {
      throw new Error(`Invalid section for change ${id}.`)
    }
    if (typeof change.kind !== 'string' || !KINDS.has(change.kind as ReleaseContentKind)) {
      throw new Error(`Invalid kind for change ${id}.`)
    }
    if (!Array.isArray(change.pullRequests) || change.pullRequests.length === 0) {
      throw new Error(`Change ${id} must reference at least one pull request.`)
    }
    const changePullRequestKeys = new Set<string>()
    const pullRequests = change.pullRequests.map((entry, pullRequestIndex) => {
      const reference = requireObject(entry, `Change ${id} pull request ${pullRequestIndex + 1}`)
      requireExactKeys(reference, ['number', 'repository'], `Change ${id} pull request ${pullRequestIndex + 1}`)
      if (!Number.isInteger(reference.number) || (reference.number as number) < 1 || typeof reference.repository !== 'string') {
        throw new Error(`Change ${id} has an invalid pull request reference.`)
      }
      const key = pullRequestKey(reference.repository, reference.number as number)
      if (!plannedPullRequests.has(key)) throw new Error(`Change ${id} references a pull request outside the frozen plan: ${key}.`)
      if (assignedPullRequests.has(key)) throw new Error(`Pull request ${key} is assigned more than once.`)
      assignedPullRequests.add(key)
      changePullRequestKeys.add(key)
      return { number: reference.number as number, repository: reference.repository }
    })

    if (!Array.isArray(change.visualUrls)) throw new Error(`Change ${id} visualUrls must be an array.`)
    const visualUrls = change.visualUrls.map((url) => {
      if (typeof url !== 'string') throw new Error(`Change ${id} contains an invalid visual URL.`)
      const visual = visualCandidates.get(url)
      if (!visual) throw new Error(`Change ${id} references a visual outside the frozen plan: ${url}.`)
      if (!changePullRequestKeys.has(pullRequestKey(visual.repository, visual.pullRequestNumber))) {
        throw new Error(`Visual ${url} must belong to a pull request assigned to change ${id}.`)
      }
      if (selectedVisualUrls.has(url)) throw new Error(`Visual is selected more than once: ${url}.`)
      selectedVisualUrls.add(url)
      return url
    })

    return {
      id,
      kind: change.kind as ReleaseContentKind,
      pullRequests,
      section: change.section as ReleaseContentSection,
      summary: requireEditorialText(change.summary, `Change ${id} summary`, 360),
      title: requireEditorialText(change.title, `Change ${id} title`, 120),
      visualUrls,
    }
  })

  if (assignedPullRequests.size !== plannedPullRequests.size) {
    const missing = [...plannedPullRequests.keys()].filter((key) => !assignedPullRequests.has(key))
    throw new Error(`Every frozen pull request must be assigned exactly once. Missing: ${missing.join(', ')}.`)
  }
  if (selectedVisualUrls.size > 4) throw new Error('Release content can select at most four visuals.')
  if (!Array.isArray(value.highlights) || value.highlights.length < 1 || value.highlights.length > 6) {
    throw new Error('Release content must contain between one and six highlights.')
  }
  const highlightSet = new Set<string>()
  const highlights = value.highlights.map((highlight) => {
    if (typeof highlight !== 'string' || !ids.has(highlight)) throw new Error(`Invalid highlight change id: ${String(highlight)}.`)
    if (highlightSet.has(highlight)) throw new Error(`Duplicate highlight change id: ${highlight}.`)
    highlightSet.add(highlight)
    return highlight
  })
  return { changes, highlights, schemaVersion: 1, summary }
}

export function computeReleaseContentDigest(content: PlatformReleaseContent): string {
  return sha256(canonicalJson(content))
}

export async function readReleaseContent(path: string, plan: PlatformReleasePlan): Promise<PlatformReleaseContent> {
  return validateReleaseContent(plan, JSON.parse(await readFile(resolve(path), 'utf8')))
}

function defaultKind(title: string): ReleaseContentKind {
  if (/^fix(?:\(|:|!)/i.test(title)) return 'fix'
  if (/^(?:build|chore|ci|docs|refactor|test)(?:\(|:|!)/i.test(title)) return 'maintenance'
  return 'feature'
}

export function releaseContentTemplate(plan: PlatformReleasePlan): PlatformReleaseContent {
  const changes = REPOSITORY_KEYS.flatMap((key) => plan.repositories[key].pullRequests.map((pullRequest) => ({
    id: `${key}-${pullRequest.number}`,
    kind: defaultKind(pullRequest.title),
    pullRequests: [{ number: pullRequest.number, repository: pullRequest.repository }],
    section: key === 'dashboard' ? 'dashboard' as const : 'public' as const,
    summary: '',
    title: '',
    visualUrls: [] as string[],
  })))
  return {
    changes,
    highlights: changes.slice(0, 6).map((change) => change.id),
    schemaVersion: 1,
    summary: '',
  }
}

const SECTION_TITLES: Record<ReleaseContentSection, string> = {
  dashboard: 'Clinic Dashboard',
  platform: 'Plattformweit',
  public: 'Website',
}

const KIND_LABELS: Record<ReleaseContentKind, string> = {
  feature: 'Neu',
  fix: 'Behoben',
  maintenance: 'Verbessert',
}

export function renderReleaseContentPreview(content: PlatformReleaseContent): string {
  const highlights = content.highlights.map((id) => content.changes.find((change) => change.id === id))
  return [
    content.summary,
    '',
    'Highlights',
    ...highlights.map((change) => `- ${change?.title ?? ''}`),
    '',
    ...(['platform', 'dashboard', 'public'] as ReleaseContentSection[]).flatMap((section) => {
      const changes = content.changes.filter((change) => change.section === section)
      return changes.length === 0 ? [] : [
        SECTION_TITLES[section],
        ...changes.map((change) => `- ${change.title}: ${change.summary}`),
        '',
      ]
    }),
  ].join('\n').trim()
}

export function selectedReleaseVisuals(plan: PlatformReleasePlan, content: PlatformReleaseContent): ReleaseVisual[] {
  const candidates = new Map(plan.visualCandidates.map((visual) => [visual.url, visual]))
  return content.changes.flatMap((change) => change.visualUrls.map((url) => candidates.get(url)!))
}

export function renderRepositoryReleaseNotes(
  plan: PlatformReleasePlan,
  content: PlatformReleaseContent,
  key: PlatformRepositoryKey,
): string {
  const repository = plan.repositories[key]
  const repositoryPullRequests = new Set(repository.pullRequests.map((pullRequest) => pullRequestKey(pullRequest.repository, pullRequest.number)))
  const changes = content.changes.filter((change) => change.section === 'platform' || change.pullRequests.some((pullRequest) =>
    repositoryPullRequests.has(pullRequestKey(pullRequest.repository, pullRequest.number))))
  const grouped = (['platform', key === 'dashboard' ? 'dashboard' : 'public'] as ReleaseContentSection[])
    .flatMap((section) => {
      const sectionChanges = changes.filter((change) => change.section === section)
      if (sectionChanges.length === 0) return []
      return [
        `## ${SECTION_TITLES[section]}`,
        '',
        ...sectionChanges.flatMap((change) => [
          `### ${change.title}`,
          '',
          `${KIND_LABELS[change.kind]}: ${change.summary}`,
          '',
        ]),
      ]
    })
  const pullRequests = repository.pullRequests.map((pullRequest) => `- [#${pullRequest.number}](${pullRequest.url}) ${pullRequest.title}`)
  const commits = repository.pullRequests.length === 0
    ? repository.commits.map((commit) => `- [${commit.sha.slice(0, 7)}](${commit.url}) ${commit.message.split(/\r?\n/, 1)[0] ?? ''}`)
    : []
  return [
    `# findmydoc ${plan.version}`,
    '',
    content.summary,
    '',
    ...grouped,
    '## Technische Referenzen',
    '',
    ...([...pullRequests, ...commits].length > 0 ? [...pullRequests, ...commits] : ['- Keine anwendungsspezifischen Commits in diesem Release.']),
    '',
    `Platform-Plan: \`${plan.digest}\``,
  ].join('\n')
}
