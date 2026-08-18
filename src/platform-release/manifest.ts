import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { canonicalJson, sha256 } from './canonical.js'
import { selectedReleaseVisuals } from './content.js'
import type {
  PlatformReleaseConfig,
  PlatformReleaseContent,
  PlatformReleaseManifestV2,
  PlatformReleaseManifestV3,
  PlatformReleasePlan,
  PlatformRepositoryKey,
  PlatformReleaseDetails,
  WorkflowRun,
  ReleaseManifest,
} from './types.js'

const REPOSITORY_KEYS: PlatformRepositoryKey[] = ['dashboard', 'website']
const FULL_SHA = /^[0-9a-f]{40}$/
const REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/

function isExactGitHubUrl(value: unknown, pathname: string): boolean {
  if (typeof value !== 'string') return false
  try {
    const url = new URL(value)
    return url.protocol === 'https:' && url.hostname === 'github.com' && !url.port &&
      !url.username && !url.password && !url.search && !url.hash && url.pathname === pathname
  } catch {
    return false
  }
}

function isExactIsoTimestamp(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value)) return false
  const normalized = new Date(value)
  if (Number.isNaN(normalized.getTime())) return false
  const milliseconds = normalized.toISOString()
  return milliseconds === value || milliseconds.replace('.000Z', 'Z') === value
}

export function createPlatformReleaseManifest(input: {
  config: PlatformReleaseConfig
  content: PlatformReleaseContent
  contentDigest: string
  plan: PlatformReleasePlan
  releases: Record<PlatformRepositoryKey, PlatformReleaseDetails>
  workflows: Record<PlatformRepositoryKey, WorkflowRun>
}): PlatformReleaseManifestV2 {
  const publicationTimes = [...new Set(REPOSITORY_KEYS.map((key) => input.releases[key].platformPublishedAt))]
  if (publicationTimes.length !== 1 || !publicationTimes[0]) {
    throw new Error('Both GitHub releases must include the same stable platform publication timestamp.')
  }
  const publishedAt = publicationTimes[0]
  const withoutDigest: Omit<PlatformReleaseManifestV2, 'manifestDigest'> = {
    changes: input.content.changes,
    components: REPOSITORY_KEYS.map((key) => ({
      commits: input.plan.repositories[key].commits,
      deploymentRun: input.workflows[key].url,
      displayName: input.config.repositories[key].displayName,
      key,
      productionUrl: input.config.repositories[key].productionUrl,
      pullRequests: input.plan.repositories[key].pullRequests.map(({ body: _body, visuals: _visuals, ...pullRequest }) => pullRequest),
      release: input.releases[key].url,
      repository: input.plan.repositories[key].repository,
      targetSha: input.plan.repositories[key].targetSha,
    })),
    contentDigest: input.contentDigest,
    highlights: input.content.highlights,
    planDigest: input.plan.digest,
    publishedAt,
    schemaVersion: 2,
    summary: input.content.summary,
    version: input.plan.version,
    visuals: selectedReleaseVisuals(input.plan, input.content),
  }
  return { ...withoutDigest, manifestDigest: sha256(canonicalJson(withoutDigest)) }
}

export function createPlatformReleaseManifestV3(input: {
  config: PlatformReleaseConfig
  content: PlatformReleaseContent
  contentDigest: string
  plan: PlatformReleasePlan
  releases: Record<PlatformRepositoryKey, PlatformReleaseDetails>
  workflows: Record<PlatformRepositoryKey, WorkflowRun>
}): PlatformReleaseManifestV3 {
  const publicationTimes = [...new Set(REPOSITORY_KEYS.map((key) => input.releases[key].platformPublishedAt))]
  if (publicationTimes.length !== 1 || !publicationTimes[0]) {
    throw new Error('Both GitHub releases must include the same stable platform publication timestamp.')
  }
  const components = REPOSITORY_KEYS.map((key) => ({
    commits: input.plan.repositories[key].commits,
    deploymentRun: input.workflows[key].url,
    displayName: input.config.repositories[key].displayName,
    key,
    productionUrl: input.config.repositories[key].productionUrl,
    pullRequests: input.plan.repositories[key].pullRequests.map(({ body: _body, visuals: _visuals, ...pullRequest }) => pullRequest),
    release: input.releases[key].url,
    repository: input.plan.repositories[key].repository,
    targetSha: input.plan.repositories[key].targetSha,
  }))
  const pullRequests = new Map(components.flatMap((component) => component.pullRequests.map((pullRequest) => [
    `${pullRequest.repository}#${pullRequest.number}`,
    { componentKey: component.key },
  ])))
  const changes = input.content.changes.map(({ section: _section, ...change }) => {
    const references = change.pullRequests.flatMap((reference) => {
      const pullRequest = pullRequests.get(`${reference.repository}#${reference.number}`)
      return pullRequest ? [pullRequest] : []
    })
    return {
      ...change,
      commitShas: [],
      componentKeys: [...new Set(references.map((reference) => reference.componentKey))].sort(),
    }
  })
  const withoutDigest: Omit<PlatformReleaseManifestV3, 'manifestDigest'> = {
    changes,
    components,
    contentDigest: input.contentDigest,
    highlights: input.content.highlights,
    notificationMode: 'standard',
    planDigest: input.plan.digest,
    publishedAt: publicationTimes[0],
    releaseMode: 'platform',
    schemaVersion: 3,
    source: { kind: 'native' },
    summary: input.content.summary,
    version: input.plan.version,
    visuals: selectedReleaseVisuals(input.plan, input.content),
  }
  return { ...withoutDigest, manifestDigest: sha256(canonicalJson(withoutDigest)) }
}

export function serializePlatformReleaseManifest(manifest: PlatformReleaseManifestV2): string {
  const { manifestDigest, ...withoutDigest } = manifest
  const expected = sha256(canonicalJson(withoutDigest))
  if (manifestDigest !== expected) throw new Error(`Platform release manifest digest mismatch: expected ${expected}.`)
  return canonicalJson(manifest)
}

export function serializeReleaseManifest(manifest: ReleaseManifest): string {
  const { manifestDigest, ...withoutDigest } = manifest
  const expected = sha256(canonicalJson(withoutDigest))
  if (manifestDigest !== expected) throw new Error(`Release manifest digest mismatch: expected ${expected}.`)
  return canonicalJson(manifest)
}

export function validatePlatformReleaseManifest(candidate: unknown): PlatformReleaseManifestV2 {
  if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) throw new Error('Platform release manifest must be an object.')
  const manifest = candidate as PlatformReleaseManifestV2
  if (manifest.schemaVersion !== 2) throw new Error('Unsupported platform release manifest schema.')
  if (!/^v\d+\.\d+\.\d+$/.test(manifest.version) || !/^[0-9a-f]{64}$/.test(manifest.planDigest) ||
    !/^[0-9a-f]{64}$/.test(manifest.contentDigest) || !/^[0-9a-f]{64}$/.test(manifest.manifestDigest)) {
    throw new Error('Platform release manifest identity is invalid.')
  }
  if (typeof manifest.summary !== 'string' || !manifest.summary.trim() || !Array.isArray(manifest.highlights) ||
    !Array.isArray(manifest.changes) || !Array.isArray(manifest.visuals) ||
    !Array.isArray(manifest.components) || manifest.components.length !== 2 ||
    !manifest.components.every((component) => component && typeof component === 'object' &&
      typeof component.repository === 'string' && typeof component.targetSha === 'string' &&
      typeof component.release === 'string' && Array.isArray(component.commits) && Array.isArray(component.pullRequests))) {
    throw new Error('Platform release manifest structure is invalid.')
  }
  serializePlatformReleaseManifest(manifest)
  return manifest
}

export function validateReleaseManifest(candidate: unknown): ReleaseManifest {
  if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) throw new Error('Release manifest must be an object.')
  const manifest = candidate as ReleaseManifest
  if (manifest.schemaVersion === 2) return validatePlatformReleaseManifest(candidate)
  if (manifest.schemaVersion !== 3) throw new Error('Unsupported release manifest schema.')
  if (!/^v\d+\.\d+\.\d+$/.test(manifest.version) || !/^[0-9a-f]{64}$/.test(manifest.planDigest) ||
    !/^[0-9a-f]{64}$/.test(manifest.contentDigest) || !/^[0-9a-f]{64}$/.test(manifest.manifestDigest)) {
    throw new Error('Release manifest identity is invalid.')
  }
  if ((manifest.releaseMode !== 'application' && manifest.releaseMode !== 'platform') ||
    (manifest.notificationMode !== 'standard' && manifest.notificationMode !== 'silent') ||
    !manifest.source || (manifest.source.kind !== 'native' && manifest.source.kind !== 'github-release-import') ||
    (manifest.source.kind === 'github-release-import' && !isExactIsoTimestamp(manifest.source.importedAt)) ||
    !isExactIsoTimestamp(manifest.publishedAt) ||
    typeof manifest.summary !== 'string' || !manifest.summary.trim() ||
    !Array.isArray(manifest.components) || !Array.isArray(manifest.changes) || !Array.isArray(manifest.highlights) || !Array.isArray(manifest.visuals)) {
    throw new Error('Release manifest v3 structure is invalid.')
  }
  if ((manifest.releaseMode === 'application' && (manifest.notificationMode !== 'silent' || manifest.source.kind !== 'github-release-import')) ||
    (manifest.releaseMode === 'platform' && (manifest.notificationMode !== 'standard' || manifest.source.kind !== 'native'))) {
    throw new Error('Release manifest v3 mode, notification, and source combination is invalid.')
  }
  if (manifest.releaseMode === 'application' ? manifest.components.length !== 1 : manifest.components.length < 2) {
    throw new Error('Release manifest v3 component count does not match its release mode.')
  }
  if (!manifest.components.every((component) => typeof component.key === 'string' && REPOSITORY.test(component.repository) &&
    FULL_SHA.test(component.targetSha) &&
    isExactGitHubUrl(component.release, `/${component.repository}/releases/tag/${manifest.version}`) &&
    (component.deploymentRun === null || /^\d+$/.test(new URL(component.deploymentRun).pathname.split('/').at(-1) ?? '')) &&
    (component.deploymentRun === null || isExactGitHubUrl(component.deploymentRun, `/${component.repository}/actions/runs/${new URL(component.deploymentRun).pathname.split('/').at(-1)}`)) &&
    Array.isArray(component.commits) && component.commits.every((commit) =>
      FULL_SHA.test(commit.sha) && typeof commit.message === 'string' &&
      isExactGitHubUrl(commit.url, `/${component.repository}/commit/${commit.sha}`)) &&
    Array.isArray(component.pullRequests) && component.pullRequests.every((pullRequest) =>
      pullRequest.repository === component.repository && Number.isInteger(pullRequest.number) && pullRequest.number > 0 &&
      isExactGitHubUrl(pullRequest.url, `/${component.repository}/pull/${pullRequest.number}`) &&
      Array.isArray(pullRequest.commitShas) && pullRequest.commitShas.every((sha) => FULL_SHA.test(sha)) &&
      Array.isArray(pullRequest.issues) && pullRequest.issues.every((issue) =>
        REPOSITORY.test(issue.repository) && Number.isInteger(issue.number) && issue.number > 0 &&
        isExactGitHubUrl(issue.url, `/${issue.repository}/issues/${issue.number}`)))) ||
    !manifest.changes.every((change) => typeof change.id === 'string' && Array.isArray(change.componentKeys) && change.componentKeys.length > 0 &&
      new Set(change.componentKeys).size === change.componentKeys.length &&
      Array.isArray(change.pullRequests) && change.pullRequests.every((reference) =>
        REPOSITORY.test(reference.repository) && Number.isInteger(reference.number) && reference.number > 0) &&
      Array.isArray(change.commitShas) && change.commitShas.every((sha) => FULL_SHA.test(sha)) && Array.isArray(change.visualUrls))) {
    throw new Error('Release manifest v3 provenance is invalid.')
  }
  const componentKeys = new Set(manifest.components.map((component) => component.key))
  if (componentKeys.size !== manifest.components.length) throw new Error('Release manifest v3 component keys must be unique.')
  const pullRequestOwners = new Map(manifest.components.flatMap((component) => component.pullRequests.map((pullRequest) => [
    `${pullRequest.repository}#${pullRequest.number}`,
    component.key,
  ])))
  const commitOwners = new Map(manifest.components.flatMap((component) => component.commits.map((commit) => [commit.sha, component.key])))
  const changeIds = new Set(manifest.changes.map((change) => change.id))
  if (changeIds.size !== manifest.changes.length || manifest.highlights.length < 1 || manifest.highlights.length > 6 ||
    manifest.highlights.some((id) => !changeIds.has(id)) || manifest.changes.some((change) =>
      change.componentKeys.some((key) => !componentKeys.has(key)) ||
      change.pullRequests.some((pullRequest) => {
        const owner = pullRequestOwners.get(`${pullRequest.repository}#${pullRequest.number}`)
        return !owner || !change.componentKeys.includes(owner)
      }) ||
      change.commitShas.some((sha) => {
        const owner = commitOwners.get(sha)
        return !owner || !change.componentKeys.includes(owner)
      }))) {
    throw new Error('Release manifest v3 change references are invalid.')
  }
  serializeReleaseManifest(manifest)
  return manifest
}

export function validateManifestAgainstConfig(
  manifest: ReleaseManifest,
  config: PlatformReleaseConfig,
): void {
  const actualKeys = manifest.components.map((component) => component.key).sort()
  const expectedKeys = manifest.schemaVersion === 2 || manifest.releaseMode === 'platform'
    ? [...REPOSITORY_KEYS].sort()
    : [manifest.components[0]!.key]
  if (JSON.stringify(actualKeys) !== JSON.stringify(expectedKeys) || new Set(actualKeys).size !== actualKeys.length) {
    throw new Error('Release manifest components do not match the trusted configuration.')
  }
  for (const key of actualKeys) {
    const component = manifest.components.find((entry) => entry.key === key)
    const configured = config.repositories[key]
    if (!component || !configured || component.repository !== configured.repository ||
      component.displayName !== configured.displayName || component.productionUrl !== configured.productionUrl) {
      throw new Error(`Platform release manifest ${key} component does not match the trusted configuration.`)
    }
    let releaseUrl: URL
    try {
      releaseUrl = new URL(component.release)
    } catch {
      throw new Error(`Platform release manifest ${key} release URL is invalid.`)
    }
    if (releaseUrl.protocol !== 'https:' || releaseUrl.hostname !== 'github.com' || releaseUrl.search || releaseUrl.hash ||
      releaseUrl.pathname !== `/${configured.repository}/releases/tag/${manifest.version}`) {
      throw new Error(`Platform release manifest ${key} release URL is untrusted.`)
    }
    if (component.deploymentRun !== null) {
      let deploymentUrl: URL
      try {
        deploymentUrl = new URL(component.deploymentRun)
      } catch {
        throw new Error(`Release manifest ${key} deployment URL is invalid.`)
      }
      if (deploymentUrl.protocol !== 'https:' || deploymentUrl.hostname !== 'github.com' ||
        !deploymentUrl.pathname.startsWith(`/${configured.repository}/actions/runs/`)) {
        throw new Error(`Release manifest ${key} deployment URL is untrusted.`)
      }
    }
  }
}

export async function readPlatformReleaseManifest(path: string): Promise<{ manifest: ReleaseManifest; serialized: string }> {
  const manifest = validateReleaseManifest(JSON.parse(await readFile(resolve(path), 'utf8')))
  return { manifest, serialized: serializeReleaseManifest(manifest) }
}
