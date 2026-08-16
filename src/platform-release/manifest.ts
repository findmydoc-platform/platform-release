import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { canonicalJson, sha256 } from './canonical.js'
import { selectedReleaseVisuals } from './content.js'
import type {
  PlatformReleaseConfig,
  PlatformReleaseContent,
  PlatformReleaseManifestV2,
  PlatformReleasePlan,
  PlatformRepositoryKey,
  PlatformReleaseDetails,
  WorkflowRun,
} from './types.js'

const REPOSITORY_KEYS: PlatformRepositoryKey[] = ['dashboard', 'website']

export function createPlatformReleaseManifest(input: {
  config: PlatformReleaseConfig
  content: PlatformReleaseContent
  contentDigest: string
  plan: PlatformReleasePlan
  releases: Record<PlatformRepositoryKey, PlatformReleaseDetails>
  workflows: Record<PlatformRepositoryKey, WorkflowRun>
}): PlatformReleaseManifestV2 {
  const publishedAt = REPOSITORY_KEYS.map((key) => input.releases[key].preparedAt).sort().at(-1)
  if (!publishedAt) throw new Error('Both GitHub releases must include a stable preparation timestamp.')
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

export function serializePlatformReleaseManifest(manifest: PlatformReleaseManifestV2): string {
  const { manifestDigest, ...withoutDigest } = manifest
  const expected = sha256(canonicalJson(withoutDigest))
  if (manifestDigest !== expected) throw new Error(`Platform release manifest digest mismatch: expected ${expected}.`)
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

export function validateManifestAgainstConfig(
  manifest: PlatformReleaseManifestV2,
  config: PlatformReleaseConfig,
): void {
  const actualKeys = manifest.components.map((component) => component.key).sort()
  if (JSON.stringify(actualKeys) !== JSON.stringify([...REPOSITORY_KEYS].sort())) {
    throw new Error('Platform release manifest components do not match the trusted configuration.')
  }
  for (const key of REPOSITORY_KEYS) {
    const component = manifest.components.find((entry) => entry.key === key)
    const configured = config.repositories[key]
    if (!component || component.repository !== configured.repository ||
      component.displayName !== configured.displayName || component.productionUrl !== configured.productionUrl) {
      throw new Error(`Platform release manifest ${key} component does not match the trusted configuration.`)
    }
    let releaseUrl: URL
    try {
      releaseUrl = new URL(component.release)
    } catch {
      throw new Error(`Platform release manifest ${key} release URL is invalid.`)
    }
    if (releaseUrl.protocol !== 'https:' || releaseUrl.hostname !== 'github.com' ||
      !releaseUrl.pathname.startsWith(`/${configured.repository}/releases/`)) {
      throw new Error(`Platform release manifest ${key} release URL is untrusted.`)
    }
  }
}

export async function readPlatformReleaseManifest(path: string): Promise<{ manifest: PlatformReleaseManifestV2; serialized: string }> {
  const manifest = validatePlatformReleaseManifest(JSON.parse(await readFile(resolve(path), 'utf8')))
  return { manifest, serialized: serializePlatformReleaseManifest(manifest) }
}
