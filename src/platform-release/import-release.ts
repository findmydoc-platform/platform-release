import { readFile } from 'node:fs/promises'
import { dirname, isAbsolute, relative, resolve } from 'node:path'
import { canonicalJson, sha256 } from './canonical.js'
import { compareVersions, parseVersion } from './semver.js'
import { validateManifestAgainstConfig, validateReleaseManifest } from './manifest.js'
import type {
  FounderOpsReleaseClient,
  PlatformReleaseConfig,
  PlatformReleaseManifestV3,
  ReleaseContentChangeV3,
  ReleaseContentKind,
  ReleaseContentV3,
  ReleaseImportBatch,
  ReleaseImportGitHubClient,
  ReleaseImportPlan,
} from './types.js'

const CHANGE_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
const DIGEST = /^[a-f0-9]{64}$/
const EMAIL_ADDRESS = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi
const EMAIL_ADDRESS_PRESENT = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i
const KINDS = new Set<ReleaseContentKind>(['feature', 'fix', 'maintenance'])

function redactEmailAddresses<T>(value: T): T {
  if (typeof value === 'string') return value.replace(EMAIL_ADDRESS, '[redacted-email]') as T
  if (Array.isArray(value)) return value.map(redactEmailAddresses) as T
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, redactEmailAddresses(entry)])) as T
  }
  return value
}

function containsEmailAddress(value: unknown): boolean {
  if (typeof value === 'string') return EMAIL_ADDRESS_PRESENT.test(value)
  if (Array.isArray(value)) return value.some(containsEmailAddress)
  if (value && typeof value === 'object') return Object.values(value).some(containsEmailAddress)
  return false
}

function requireObject(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object.`)
  return value as Record<string, unknown>
}

function requireLine(value: unknown, label: string, maximum: number): string {
  if (typeof value !== 'string') throw new Error(`${label} must be a string.`)
  const result = value.trim()
  if (!result || result.length > maximum || /[\r\n]/.test(result)) throw new Error(`${label} must be one non-empty line with at most ${maximum} characters.`)
  return result
}

function pullRequestKey(repository: string, number: number): string {
  return `${repository.toLowerCase()}#${number}`
}

function importPlanDigest(plan: Omit<ReleaseImportPlan, 'digest'> | ReleaseImportPlan): string {
  const { createdAt: _createdAt, digest: _digest, ...durable } = plan as ReleaseImportPlan
  return sha256(canonicalJson(durable))
}

export function releaseNotesPullRequests(body: string): Set<string> {
  const references = new Set<string>()
  for (const match of body.matchAll(/https:\/\/github\.com\/([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)\/pull\/(\d+)/g)) {
    references.add(pullRequestKey(match[1]!, Number(match[2])))
  }
  return references
}

export async function createReleaseImportPlans(input: {
  componentKey: string
  config: PlatformReleaseConfig
  deploymentRuns?: Record<string, string | null>
  versions: string[]
}, github: ReleaseImportGitHubClient): Promise<ReleaseImportPlan[]> {
  const component = input.config.repositories[input.componentKey]
  if (!component) throw new Error(`Unknown release component: ${input.componentKey}.`)
  const versions = [...new Set(input.versions)]
  if (versions.length === 0 || versions.length > 8) throw new Error('An import plan batch must contain between one and eight versions.')
  versions.forEach(parseVersion)
  const releases = await github.getPublishedReleases(component.repository)
  const releaseByVersion = new Map(releases.map((release) => [release.version, release]))
  const plans: ReleaseImportPlan[] = []
  for (const version of versions.sort(compareVersions).reverse()) {
    const release = releaseByVersion.get(version)
    if (!release) throw new Error(`${component.repository} has no published regular release ${version}.`)
    const releaseIndex = releases.findIndex((candidate) => candidate.version === version)
    const previous = releaseIndex > 0 ? releases[releaseIndex - 1] : undefined
    const commits = previous
      ? await github.compareCommits(component.repository, previous.targetSha, release.targetSha)
      : await github.getAllCommits(component.repository, release.targetSha)
    if (commits.length === 0) throw new Error(`${component.repository} ${version} has no commits in its release range.`)
    const pullRequests = await github.getPullRequests(component.repository, commits)
    const assignedCommitShas = new Set(pullRequests.flatMap((pullRequest) => pullRequest.commitShas))
    const orphanCommits = commits.filter((commit) => !assignedCommitShas.has(commit.sha)).map((commit) => commit.sha)
    const notesReferences = releaseNotesPullRequests(release.body)
    const mappedReferences = new Set(pullRequests.map((pullRequest) => pullRequestKey(pullRequest.repository, pullRequest.number)))
    const reviewRequired = [
      ...[...notesReferences].filter((reference) => !mappedReferences.has(reference)).map((reference) => `Release notes reference ${reference}, but the tag range does not.`),
      ...[...mappedReferences].filter((reference) => !notesReferences.has(reference)).map((reference) => `Tag range contains ${reference}, but the release notes do not reference it.`),
      ...(!release.body.trim() ? ['GitHub release notes are empty.'] : []),
    ]
    const deploymentRun = input.deploymentRuns?.[version] ?? null
    if (deploymentRun !== null) {
      const url = new URL(deploymentRun)
      if (url.protocol !== 'https:' || url.hostname !== 'github.com') throw new Error(`Deployment run for ${version} must be a GitHub HTTPS URL.`)
    }
    const planWithoutDigest = redactEmailAddresses<Omit<ReleaseImportPlan, 'digest'>>({
      commits,
      component: {
        displayName: component.displayName,
        key: input.componentKey,
        productionUrl: component.productionUrl,
        repository: component.repository,
      },
      createdAt: new Date().toISOString(),
      deploymentRun,
      orphanCommits,
      previousVersion: previous?.version ?? null,
      publishedAt: release.publishedAt,
      pullRequests,
      releaseNotes: release.body,
      releaseUrl: release.releaseUrl,
      reviewRequired,
      schemaVersion: 1,
      targetSha: release.targetSha,
      version,
    })
    const plan = { ...planWithoutDigest, digest: importPlanDigest(planWithoutDigest) }
    plans.push(validateReleaseImportPlan(plan, input.config))
  }
  return plans
}

export function validateReleaseImportPlan(candidate: unknown, config?: PlatformReleaseConfig): ReleaseImportPlan {
  const plan = requireObject(candidate, 'Release import plan') as unknown as ReleaseImportPlan
  if (plan.schemaVersion !== 1 || !/^v\d+\.\d+\.\d+$/.test(plan.version) || !DIGEST.test(plan.digest)) throw new Error('Release import plan identity is invalid.')
  if (!plan.component || typeof plan.component.key !== 'string' || typeof plan.component.repository !== 'string' ||
    typeof plan.component.displayName !== 'string' || typeof plan.component.productionUrl !== 'string') throw new Error('Release import component is invalid.')
  if (!Array.isArray(plan.commits) || !Array.isArray(plan.pullRequests) || !Array.isArray(plan.orphanCommits) || !Array.isArray(plan.reviewRequired)) throw new Error('Release import provenance is incomplete.')
  if (containsEmailAddress(plan)) throw new Error('Release import plans must not contain plain-text email addresses.')
  if (typeof plan.releaseUrl !== 'string' || typeof plan.targetSha !== 'string' || typeof plan.publishedAt !== 'string' || Number.isNaN(Date.parse(plan.publishedAt))) throw new Error('Release import publication metadata is invalid.')
  if (plan.deploymentRun !== null && typeof plan.deploymentRun !== 'string') throw new Error('Release import deployment evidence is invalid.')
  if (config) {
    const configured = config.repositories[plan.component.key]
    if (!configured || configured.repository !== plan.component.repository || configured.displayName !== plan.component.displayName || configured.productionUrl !== plan.component.productionUrl) {
      throw new Error(`Release import component ${plan.component.key} does not match the trusted catalog.`)
    }
  }
  const expected = importPlanDigest(plan)
  if (plan.digest !== expected) throw new Error(`Release import plan digest mismatch: expected ${expected}.`)
  return plan
}

export function reuseReleaseImportPlan(
  existing: unknown,
  candidate: ReleaseImportPlan,
  config: PlatformReleaseConfig,
): ReleaseImportPlan {
  const existingObject = requireObject(existing, 'Existing release import plan') as unknown as ReleaseImportPlan
  const redactedExisting = redactEmailAddresses(existingObject)
  const normalizedExisting = { ...redactedExisting, digest: importPlanDigest(redactedExisting) }
  const validatedExisting = validateReleaseImportPlan(normalizedExisting, config)
  const validatedCandidate = validateReleaseImportPlan(candidate, config)
  if (validatedExisting.digest !== validatedCandidate.digest) {
    throw new Error('Existing release import plan differs from the current durable GitHub state.')
  }
  return validatedExisting
}

function defaultKind(title: string): ReleaseContentKind {
  if (/^fix(?:\(|:|!)/i.test(title)) return 'fix'
  if (/^(?:build|chore|ci|docs|refactor|test)(?:\(|:|!)/i.test(title)) return 'maintenance'
  return 'feature'
}

export function releaseImportContentTemplate(plan: ReleaseImportPlan): ReleaseContentV3 {
  const changes = [
    ...plan.pullRequests.map((pullRequest): ReleaseContentChangeV3 => ({
      commitShas: [],
      componentKeys: [plan.component.key],
      id: `${plan.component.key}-pr-${pullRequest.number}`,
      kind: defaultKind(pullRequest.title),
      pullRequests: [{ number: pullRequest.number, repository: pullRequest.repository }],
      summary: '',
      title: '',
      visualUrls: [],
    })),
    ...plan.orphanCommits.map((sha): ReleaseContentChangeV3 => ({
      commitShas: [sha],
      componentKeys: [plan.component.key],
      id: `${plan.component.key}-commit-${sha.slice(0, 12)}`,
      kind: defaultKind(plan.commits.find((commit) => commit.sha === sha)?.message ?? ''),
      pullRequests: [],
      summary: '',
      title: '',
      visualUrls: [],
    })),
  ]
  return {
    changes,
    highlights: changes.slice(0, 6).map((change) => change.id),
    reviewAcknowledgements: [],
    schemaVersion: 2,
    summary: '',
  }
}

export function validateReleaseImportContent(plan: ReleaseImportPlan, candidate: unknown): ReleaseContentV3 {
  const value = requireObject(candidate, 'Release import content')
  if (value.schemaVersion !== 2) throw new Error('Unsupported release import content schema.')
  const summary = requireLine(value.summary, 'Release summary', 280)
  if (!Array.isArray(value.changes) || value.changes.length < 1 || value.changes.length > 3) throw new Error('Release import content must contain between one and three changes.')
  const plannedPullRequests = new Set(plan.pullRequests.map((pullRequest) => pullRequestKey(pullRequest.repository, pullRequest.number)))
  const plannedOrphans = new Set(plan.orphanCommits)
  const assignedPullRequests = new Set<string>()
  const assignedOrphans = new Set<string>()
  const ids = new Set<string>()
  const changes = value.changes.map((candidateChange, index): ReleaseContentChangeV3 => {
    const change = requireObject(candidateChange, `Change ${index + 1}`)
    const id = requireLine(change.id, `Change ${index + 1} id`, 80)
    if (!CHANGE_ID.test(id) || ids.has(id)) throw new Error(`Change id is invalid or duplicated: ${id}.`)
    ids.add(id)
    if (typeof change.kind !== 'string' || !KINDS.has(change.kind as ReleaseContentKind)) throw new Error(`Change ${id} kind is invalid.`)
    if (!Array.isArray(change.componentKeys) || change.componentKeys.length !== 1 || change.componentKeys[0] !== plan.component.key) throw new Error(`Change ${id} must reference only component ${plan.component.key}.`)
    if (!Array.isArray(change.pullRequests) || !Array.isArray(change.commitShas) || !Array.isArray(change.visualUrls) || change.visualUrls.length !== 0) throw new Error(`Change ${id} references are invalid; imported releases do not select visuals.`)
    const pullRequests = change.pullRequests.map((candidateReference) => {
      const reference = requireObject(candidateReference, `Change ${id} pull request`)
      if (typeof reference.repository !== 'string' || !Number.isInteger(reference.number)) throw new Error(`Change ${id} has an invalid pull request reference.`)
      const key = pullRequestKey(reference.repository, Number(reference.number))
      if (!plannedPullRequests.has(key) || assignedPullRequests.has(key)) throw new Error(`Pull request ${key} is outside the plan or assigned more than once.`)
      assignedPullRequests.add(key)
      return { number: Number(reference.number), repository: reference.repository }
    })
    const commitShas = change.commitShas.map((sha) => {
      if (typeof sha !== 'string' || !plannedOrphans.has(sha) || assignedOrphans.has(sha)) throw new Error(`Commit ${String(sha)} is outside the orphan set or assigned more than once.`)
      assignedOrphans.add(sha)
      return sha
    })
    if (pullRequests.length === 0 && commitShas.length === 0) throw new Error(`Change ${id} must assign at least one pull request or orphan commit.`)
    return {
      commitShas,
      componentKeys: [plan.component.key],
      id,
      kind: change.kind as ReleaseContentKind,
      pullRequests,
      summary: requireLine(change.summary, `Change ${id} summary`, 360),
      title: requireLine(change.title, `Change ${id} title`, 120),
      visualUrls: [],
    }
  })
  const missingPullRequests = [...plannedPullRequests].filter((key) => !assignedPullRequests.has(key))
  const missingOrphans = [...plannedOrphans].filter((sha) => !assignedOrphans.has(sha))
  if (missingPullRequests.length || missingOrphans.length) throw new Error(`Every pull request and orphan commit must be assigned exactly once. Missing PRs: ${missingPullRequests.join(', ') || 'none'}; missing commits: ${missingOrphans.join(', ') || 'none'}.`)
  if (!Array.isArray(value.highlights) || value.highlights.length < 1 || value.highlights.length > 6) throw new Error('Release import content must contain between one and six highlights.')
  const highlights = value.highlights.map((highlight) => {
    if (typeof highlight !== 'string' || !ids.has(highlight)) throw new Error(`Invalid highlight: ${String(highlight)}.`)
    return highlight
  })
  if (new Set(highlights).size !== highlights.length) throw new Error('Release import highlights must be unique.')
  if (!Array.isArray(value.reviewAcknowledgements) || value.reviewAcknowledgements.some((entry) => typeof entry !== 'string')) {
    throw new Error('Release import review acknowledgements must be an array of exact plan findings.')
  }
  const reviewAcknowledgements = [...value.reviewAcknowledgements].sort()
  const requiredAcknowledgements = [...plan.reviewRequired].sort()
  if (new Set(reviewAcknowledgements).size !== reviewAcknowledgements.length ||
    JSON.stringify(reviewAcknowledgements) !== JSON.stringify(requiredAcknowledgements)) {
    throw new Error('Release import content must acknowledge every exact plan review finding once.')
  }
  return { changes, highlights, reviewAcknowledgements, schemaVersion: 2, summary }
}

export function releaseImportContentDigest(content: ReleaseContentV3): string {
  return sha256(canonicalJson(content))
}

export function buildReleaseImportManifest(plan: ReleaseImportPlan, content: ReleaseContentV3, config: PlatformReleaseConfig): PlatformReleaseManifestV3 {
  validateReleaseImportPlan(plan, config)
  const validatedContent = validateReleaseImportContent(plan, content)
  const withoutDigest: Omit<PlatformReleaseManifestV3, 'manifestDigest'> = {
    changes: validatedContent.changes,
    components: [{
      commits: plan.commits,
      deploymentRun: plan.deploymentRun,
      displayName: plan.component.displayName,
      key: plan.component.key,
      productionUrl: plan.component.productionUrl,
      pullRequests: plan.pullRequests.map(({ body: _body, visuals: _visuals, ...pullRequest }) => pullRequest),
      release: plan.releaseUrl,
      repository: plan.component.repository,
      targetSha: plan.targetSha,
    }],
    contentDigest: releaseImportContentDigest(validatedContent),
    highlights: validatedContent.highlights,
    notificationMode: 'silent',
    planDigest: plan.digest,
    publishedAt: plan.publishedAt,
    releaseMode: 'application',
    schemaVersion: 3,
    source: { importedAt: plan.createdAt, kind: 'github-release-import' },
    summary: validatedContent.summary,
    version: plan.version,
    visuals: [],
  }
  return { ...withoutDigest, manifestDigest: sha256(canonicalJson(withoutDigest)) }
}

export function serializeReleaseImportManifest(manifest: PlatformReleaseManifestV3): string {
  const { manifestDigest, ...withoutDigest } = manifest
  const expected = sha256(canonicalJson(withoutDigest))
  if (manifestDigest !== expected) throw new Error(`Release import manifest digest mismatch: expected ${expected}.`)
  return canonicalJson(manifest)
}

function batchDigest(batch: Omit<ReleaseImportBatch, 'digest'> | ReleaseImportBatch): string {
  const { digest: _digest, ...unsigned } = batch as ReleaseImportBatch
  return sha256(canonicalJson(unsigned))
}

export function createReleaseImportBatch(releases: ReleaseImportBatch['releases']): ReleaseImportBatch {
  if (releases.length < 1 || releases.length > 8) throw new Error('A release import batch must contain between one and eight releases.')
  const sorted = [...releases].sort((left, right) => compareVersions(right.version, left.version))
  if (new Set(sorted.map((release) => release.version)).size !== sorted.length) throw new Error('A release import batch cannot contain duplicate versions.')
  for (const release of sorted) {
    if (!/^v\d+\.\d+\.\d+$/.test(release.version) || !DIGEST.test(release.manifestDigest) || isAbsolute(release.manifestPath) || release.manifestPath.split(/[\\/]/).includes('..')) {
      throw new Error(`Release import batch entry is invalid for ${release.version}.`)
    }
  }
  const unsigned = { releases: sorted, schemaVersion: 1 as const }
  return { ...unsigned, digest: batchDigest(unsigned) }
}

export function validateReleaseImportBatch(candidate: unknown): ReleaseImportBatch {
  const value = requireObject(candidate, 'Release import batch') as unknown as ReleaseImportBatch
  if (value.schemaVersion !== 1 || !DIGEST.test(value.digest) || !Array.isArray(value.releases)) throw new Error('Release import batch is invalid.')
  const normalized = createReleaseImportBatch(value.releases)
  if (value.digest !== normalized.digest) throw new Error(`Release import batch digest mismatch: expected ${normalized.digest}.`)
  return value
}

export async function ingestReleaseImportBatch(input: {
  apply: boolean
  batchPath: string
  config: PlatformReleaseConfig
  confirmBatchDigest: string
}, founderOps: FounderOpsReleaseClient): Promise<Array<{ replayed: boolean; url: string; version: string }>> {
  if (!input.apply) throw new Error('--apply is required for release import ingestion.')
  const batchPath = resolve(input.batchPath)
  const batch = validateReleaseImportBatch(JSON.parse(await readFile(batchPath, 'utf8')))
  if (input.confirmBatchDigest !== batch.digest) throw new Error(`Batch digest confirmation must exactly match ${batch.digest}.`)
  const root = dirname(batchPath)
  const results: Array<{ replayed: boolean; url: string; version: string }> = []
  for (const entry of batch.releases) {
    const manifestPath = resolve(root, entry.manifestPath)
    if (relative(root, manifestPath).startsWith('..')) throw new Error(`Manifest path escapes the batch directory for ${entry.version}.`)
    const manifest = validateReleaseManifest(JSON.parse(await readFile(manifestPath, 'utf8'))) as PlatformReleaseManifestV3
    if (manifest.schemaVersion !== 3 || manifest.releaseMode !== 'application' || manifest.notificationMode !== 'silent' || manifest.source?.kind !== 'github-release-import' || manifest.version !== entry.version) {
      throw new Error(`Stored manifest is not a silent application import for ${entry.version}.`)
    }
    validateManifestAgainstConfig(manifest, input.config)
    const serialized = serializeReleaseImportManifest(manifest)
    if (manifest.manifestDigest !== entry.manifestDigest) throw new Error(`Stored manifest digest differs from the batch for ${entry.version}.`)
    const result = await founderOps.ingestManifest({ manifest: serialized, manifestDigest: manifest.manifestDigest })
    results.push({ ...result, version: manifest.version })
  }
  return results
}
