import { announcePlatformReleaseOnce } from './announce.js'
import { releaseNotesBody } from './apply.js'
import { computeReleaseContentDigest, renderRepositoryReleaseNotes, validateReleaseContent } from './content.js'
import {
  createPlatformReleaseManifest,
  createPlatformReleaseManifestV3,
  serializeReleaseManifest,
  validateManifestAgainstConfig,
} from './manifest.js'
import {
  platformDeploymentWorkflowTitle,
  validatePlanAgainstConfig,
  validatePlatformReleasePlan,
} from './plan.js'
import type {
  FounderOpsReleaseClient,
  PlatformReleaseAnnouncementStore,
  PlatformReleaseConfig,
  PlatformReleaseContent,
  PlatformReleaseDetails,
  PlatformReleaseGitHubClient,
  PlatformReleasePlan,
  PlatformRepositoryKey,
  ReleaseManifest,
  WorkflowRun,
} from './types.js'

const REPOSITORY_KEYS: PlatformRepositoryKey[] = ['dashboard', 'website']

export type ImmutableManifestGapRecoveryInput = {
  announce: boolean
  config: PlatformReleaseConfig
  confirmContentDigest: string
  confirmDigest: string
  confirmManifestDigest: string
  confirmMissingManifestRepository: string
  confirmMissingPlatformPublishedAt?: boolean
  confirmPlatformPublishedAt?: string
  confirmMutableManifestRepository: string
  confirmVersion: string
  content: PlatformReleaseContent
  forceAnnouncement?: boolean
  manifest: ReleaseManifest
  plan: PlatformReleasePlan
  serializedManifest: string
  webhook?: string
}

export type ImmutableManifestGapRecoveryInspection = {
  contentDigest: string
  digest: string
  manifestDigest: string
  missingManifestRepository: string
  missingPlatformPublishedAt?: true
  platformPublishedAt?: string
  mutableManifestRepository: string
  releases: Record<PlatformRepositoryKey, { immutable: boolean; manifestAttached: boolean; url: string }>
  status: 'ready'
  version: string
  workflows: Record<PlatformRepositoryKey, WorkflowRun>
}

type ValidatedRecovery = ImmutableManifestGapRecoveryInspection & {
  releasesForManifest: Record<PlatformRepositoryKey, PlatformReleaseDetails>
}

function manifestComponent(manifest: ReleaseManifest, key: PlatformRepositoryKey) {
  const component = manifest.components.find((entry) => entry.key === key)
  if (!component) throw new Error(`Platform release manifest is missing the ${key} component.`)
  return component
}

function assertConfirmations(input: ImmutableManifestGapRecoveryInput, contentDigest: string): void {
  if (input.confirmVersion !== input.plan.version) {
    throw new Error(`Confirmation must exactly match ${input.plan.version}.`)
  }
  if (input.confirmDigest !== input.plan.digest) {
    throw new Error(`Digest confirmation must exactly match ${input.plan.digest}.`)
  }
  if (input.confirmContentDigest !== contentDigest) {
    throw new Error(`Content digest confirmation must exactly match ${contentDigest}.`)
  }
  if (input.confirmManifestDigest !== input.manifest.manifestDigest) {
    throw new Error(`Manifest digest confirmation must exactly match ${input.manifest.manifestDigest}.`)
  }
}

async function validateImmutableManifestGap(
  input: ImmutableManifestGapRecoveryInput,
  github: PlatformReleaseGitHubClient,
): Promise<ValidatedRecovery> {
  validatePlatformReleasePlan(input.plan)
  validatePlanAgainstConfig(input.plan, input.config)
  const content = validateReleaseContent(input.plan, input.content)
  const contentDigest = computeReleaseContentDigest(content)
  validateManifestAgainstConfig(input.manifest, input.config)
  if (serializeReleaseManifest(input.manifest) !== input.serializedManifest) {
    throw new Error('The supplied manifest bytes are not the canonical approved manifest.')
  }
  assertConfirmations(input, contentDigest)
  if (input.manifest.version !== input.plan.version || input.manifest.planDigest !== input.plan.digest ||
    input.manifest.contentDigest !== contentDigest) {
    throw new Error('The manifest identity does not match the frozen plan and approved content.')
  }

  const missingKey = REPOSITORY_KEYS.find((key) =>
    input.config.repositories[key].repository === input.confirmMissingManifestRepository)
  if (!missingKey) {
    throw new Error('The confirmed missing-manifest repository is not a configured platform component.')
  }
  const mutableKey = REPOSITORY_KEYS.find((key) =>
    input.config.repositories[key].repository === input.confirmMutableManifestRepository)
  if (!mutableKey || mutableKey === missingKey) {
    throw new Error('The confirmed mutable manifest repository must be the other configured platform component.')
  }
  if (input.manifest.schemaVersion === 2 && !input.confirmMissingPlatformPublishedAt) {
    throw new Error('The missing legacy platform publication metadata must be explicitly confirmed for Manifest v2.')
  }
  if (input.manifest.schemaVersion === 3 && input.confirmPlatformPublishedAt !== input.manifest.publishedAt) {
    throw new Error(`Platform publication timestamp confirmation must exactly match ${input.manifest.publishedAt}.`)
  }
  if (input.announce && !input.webhook) {
    throw new Error('GOOGLE_CHAT_WEBHOOK_URL is required with --announce.')
  }

  const workflowEntries = await Promise.all(REPOSITORY_KEYS.map(async (key) => {
    const repository = input.plan.repositories[key]
    if (!await github.isAncestor(repository.repository, repository.targetSha, repository.branch)) {
      throw new Error(`Frozen target ${repository.targetSha} is no longer reachable from ${repository.repository}:${repository.branch}.`)
    }
    const workflow = await github.findWorkflowRun({
      branch: repository.branch,
      repository: repository.repository,
      title: platformDeploymentWorkflowTitle(input.plan, key),
      workflow: repository.deploymentWorkflow,
    })
    if (!workflow || workflow.status !== 'completed' || workflow.conclusion !== 'success') {
      throw new Error(`${repository.repository} does not have the successful frozen deployment run required for recovery.`)
    }
    if (workflow.url !== manifestComponent(input.manifest, key).deploymentRun) {
      throw new Error(`${repository.repository} deployment run does not match the approved manifest.`)
    }
    return [key, workflow] as const
  }))
  const workflows = Object.fromEntries(workflowEntries) as Record<PlatformRepositoryKey, WorkflowRun>

  const releaseEntries = await Promise.all(REPOSITORY_KEYS.map(async (key) => {
    const repository = input.plan.repositories[key]
    const component = manifestComponent(input.manifest, key)
    const release = await github.getRelease(repository.repository, input.plan.version)
    if (!release || release.draft || !release.publishedAt || release.sha !== repository.targetSha || release.url !== component.release) {
      throw new Error(`${repository.repository} release does not match the frozen plan and approved manifest.`)
    }
    if (input.manifest.schemaVersion === 2 && release.platformPublishedAt !== undefined) {
      throw new Error(`${repository.repository} does not match the explicitly confirmed missing legacy platform publication metadata.`)
    }
    if (input.manifest.schemaVersion === 3 && release.platformPublishedAt !== input.manifest.publishedAt) {
      throw new Error(`${repository.repository} does not match the confirmed platform publication timestamp.`)
    }
    const expectedNotes = renderRepositoryReleaseNotes(input.plan, content, key)
    if (releaseNotesBody(release.body) !== expectedNotes.trim()) {
      throw new Error(`${repository.repository} release notes do not match the approved content.`)
    }

    const existingManifest = await github.getReleaseManifest(repository.repository, input.plan.version)
    if (key === missingKey) {
      if (!release.immutable || release.manifestAttached || existingManifest !== undefined) {
        throw new Error(`${repository.repository} is not the single immutable missing-manifest gap approved for recovery.`)
      }
    } else {
      if (release.immutable || key !== mutableKey) {
        throw new Error(`${repository.repository} does not match the explicitly confirmed mutable manifest-bearing release.`)
      }
      if (!release.manifestAttached || existingManifest !== input.serializedManifest) {
        throw new Error(`${repository.repository} must contain the byte-identical approved manifest before recovery.`)
      }
    }
    return [key, { ...release, platformPublishedAt: input.manifest.publishedAt }] as const
  }))
  const releasesForManifest = Object.fromEntries(releaseEntries) as Record<PlatformRepositoryKey, PlatformReleaseDetails>
  const manifestInput = { config: input.config, content, contentDigest, plan: input.plan, releases: releasesForManifest, workflows }
  const expectedManifest = serializeReleaseManifest(input.manifest.schemaVersion === 2
    ? createPlatformReleaseManifest(manifestInput)
    : createPlatformReleaseManifestV3(manifestInput))
  if (expectedManifest !== input.serializedManifest) {
    throw new Error('The approved manifest provenance does not exactly match the frozen plan, content, deployments, and releases.')
  }

  return {
    contentDigest,
    digest: input.plan.digest,
    manifestDigest: input.manifest.manifestDigest,
    missingManifestRepository: input.confirmMissingManifestRepository,
    ...(input.manifest.schemaVersion === 2
      ? { missingPlatformPublishedAt: true as const }
      : { platformPublishedAt: input.manifest.publishedAt }),
    mutableManifestRepository: input.confirmMutableManifestRepository,
    releases: Object.fromEntries(REPOSITORY_KEYS.map((key) => [key, {
      immutable: releasesForManifest[key].immutable,
      manifestAttached: releasesForManifest[key].manifestAttached,
      url: releasesForManifest[key].url,
    }])) as ImmutableManifestGapRecoveryInspection['releases'],
    releasesForManifest,
    status: 'ready',
    version: input.plan.version,
    workflows,
  }
}

export async function inspectImmutableManifestGapRecovery(
  input: ImmutableManifestGapRecoveryInput,
  github: PlatformReleaseGitHubClient,
): Promise<ImmutableManifestGapRecoveryInspection> {
  const { releasesForManifest: _releasesForManifest, ...inspection } = await validateImmutableManifestGap(input, github)
  return inspection
}

export async function recoverImmutableManifestGap(
  input: ImmutableManifestGapRecoveryInput,
  github: PlatformReleaseGitHubClient,
  founderOps: FounderOpsReleaseClient,
  announcementStore: PlatformReleaseAnnouncementStore,
  options: { fetchImpl?: typeof fetch } = {},
): Promise<Omit<ImmutableManifestGapRecoveryInspection, 'status'> & {
  announcement: 'already_sent' | 'sent' | 'skipped'
  founderOps: Awaited<ReturnType<FounderOpsReleaseClient['ingestManifest']>>
  status: 'recovered'
}> {
  const inspection = await inspectImmutableManifestGapRecovery(input, github)
  const founderOpsResult = await founderOps.ingestManifest({
    manifest: input.serializedManifest,
    manifestDigest: input.manifest.manifestDigest,
  })
  let announcement: 'already_sent' | 'sent' | 'skipped' = 'skipped'
  if (input.announce) {
    announcement = await announcePlatformReleaseOnce({
      allowedMissingManifestRepository: input.confirmMissingManifestRepository,
      forcePending: input.forceAnnouncement,
      founderOpsUrl: founderOpsResult.url,
      manifest: input.manifest,
      webhook: input.webhook ?? '',
    }, github, announcementStore, options.fetchImpl)
  }
  return { ...inspection, announcement, founderOps: founderOpsResult, status: 'recovered' }
}
