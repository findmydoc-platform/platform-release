import { announcePlatformReleaseOnce } from './announce.js'
import { computeReleaseContentDigest, renderRepositoryReleaseNotes, validateReleaseContent } from './content.js'
import { createPlatformReleaseManifest, serializePlatformReleaseManifest } from './manifest.js'
import {
  platformDeploymentWorkflowTitle,
  validatePlanAgainstConfig,
  validatePlatformReleasePlan,
} from './plan.js'
import type {
  PlatformReleaseApplyResult,
  PlatformReleaseConfig,
  PlatformReleaseContent,
  FounderOpsReleaseClient,
  PlatformReleaseGitHubClient,
  PlatformReleasePlan,
  PlatformRepositoryKey,
  WorkflowRun,
} from './types.js'

const REPOSITORY_KEYS: PlatformRepositoryKey[] = ['dashboard', 'website']
const ANNOUNCEMENT_MARKER = /\n*<!--\s*findmydoc-platform-announcement:(?:pending|sent)\s*-->\s*$/

const delay = (milliseconds: number) => new Promise<void>((resolveDelay) => setTimeout(resolveDelay, milliseconds))

async function waitForWorkflow(
  plan: PlatformReleasePlan,
  key: PlatformRepositoryKey,
  github: PlatformReleaseGitHubClient,
  options: { pollIntervalMs: number; timeoutMs: number },
  ignoreRunId?: number,
): Promise<WorkflowRun> {
  const repository = plan.repositories[key]
  const startedAt = Date.now()
  while (Date.now() - startedAt < options.timeoutMs) {
    const run = await github.findWorkflowRun({
      branch: repository.branch,
      repository: repository.repository,
      title: platformDeploymentWorkflowTitle(plan, key),
      workflow: repository.deploymentWorkflow,
    })
    if (run?.databaseId === ignoreRunId) {
      await delay(options.pollIntervalMs)
      continue
    }
    if (run?.status === 'completed') {
      if (run.conclusion !== 'success') {
        throw new Error(`${repository.repository} deployment failed: ${run.url}`)
      }
      return run
    }
    await delay(options.pollIntervalMs)
  }
  throw new Error(`${repository.repository} deployment did not complete before the timeout.`)
}

async function ensureDeployment(
  plan: PlatformReleasePlan,
  key: PlatformRepositoryKey,
  github: PlatformReleaseGitHubClient,
  options: { pollIntervalMs: number; timeoutMs: number },
): Promise<WorkflowRun> {
  const repository = plan.repositories[key]
  const existing = await github.findWorkflowRun({
    branch: repository.branch,
    repository: repository.repository,
    title: platformDeploymentWorkflowTitle(plan, key),
    workflow: repository.deploymentWorkflow,
  })
  if (existing?.status === 'completed' && existing.conclusion === 'success') return existing
  let ignoreRunId: number | undefined
  if (!existing || existing.status === 'completed') {
    if (existing?.conclusion !== 'success') ignoreRunId = existing?.databaseId
    await github.dispatchWorkflow({
      branch: repository.branch,
      inputs: {
        plan_digest: plan.digest,
        platform_version: plan.version,
        target_sha: repository.targetSha,
      },
      repository: repository.repository,
      workflow: repository.deploymentWorkflow,
    })
    await delay(Math.min(options.pollIntervalMs, 5_000))
  }
  return waitForWorkflow(plan, key, github, options, ignoreRunId)
}

export async function applyPlatformRelease(
  input: {
    announce: boolean
    config: PlatformReleaseConfig
    confirmContentDigest: string
    confirmDigest: string
    confirmVersion: string
    content: PlatformReleaseContent
    onManifest?: (manifest: string) => Promise<void>
    plan: PlatformReleasePlan
    webhook?: string
  },
  github: PlatformReleaseGitHubClient,
  founderOps: FounderOpsReleaseClient,
  options: { pollIntervalMs?: number; timeoutMs?: number } = {},
): Promise<PlatformReleaseApplyResult> {
  validatePlatformReleasePlan(input.plan)
  validatePlanAgainstConfig(input.plan, input.config)
  const content = validateReleaseContent(input.plan, input.content)
  const contentDigest = computeReleaseContentDigest(content)
  if (input.confirmDigest !== input.plan.digest) {
    throw new Error(`Digest confirmation must exactly match ${input.plan.digest}.`)
  }
  if (input.confirmVersion !== input.plan.version) {
    throw new Error(`Confirmation must exactly match ${input.plan.version}.`)
  }
  if (input.confirmContentDigest !== contentDigest) {
    throw new Error(`Content digest confirmation must exactly match ${contentDigest}.`)
  }
  if (input.announce && !input.webhook) throw new Error('GOOGLE_CHAT_WEBHOOK_URL is required with --announce.')

  for (const key of REPOSITORY_KEYS) {
    const repository = input.plan.repositories[key]
    if (!await github.isAncestor(repository.repository, repository.targetSha, repository.branch)) {
      throw new Error(`Frozen target ${repository.targetSha} is no longer reachable from ${repository.repository}:${repository.branch}.`)
    }
  }

  const workflowOptions = {
    pollIntervalMs: options.pollIntervalMs ?? 10_000,
    timeoutMs: options.timeoutMs ?? 45 * 60_000,
  }
  const workflowEntries = await Promise.all(REPOSITORY_KEYS.map(async (key) =>
    [key, await ensureDeployment(input.plan, key, github, workflowOptions)] as const))
  const workflows = Object.fromEntries(workflowEntries) as PlatformReleaseApplyResult['workflows']

  const releaseEntries: Array<readonly [PlatformRepositoryKey, Awaited<ReturnType<PlatformReleaseGitHubClient['createRelease']>>]> = []
  for (const key of REPOSITORY_KEYS) {
    const repository = input.plan.repositories[key]
    const expectedBody = renderRepositoryReleaseNotes(input.plan, content, key)
    const existing = await github.getRelease(repository.repository, input.plan.version)
    if (existing && existing.sha !== repository.targetSha) {
      throw new Error(`${repository.repository} ${input.plan.version} points to ${existing.sha}, not ${repository.targetSha}.`)
    }
    if (existing && existing.body.replace(ANNOUNCEMENT_MARKER, '').trim() !== expectedBody.trim()) {
      throw new Error(`${repository.repository} ${input.plan.version} release notes do not match the approved content.`)
    }
    const release = existing ?? await github.createRelease({
      body: expectedBody,
      repository: repository.repository,
      targetSha: repository.targetSha,
      version: input.plan.version,
    })
    releaseEntries.push([key, release])
  }
  const releaseDetails = Object.fromEntries(releaseEntries) as Record<PlatformRepositoryKey, Awaited<ReturnType<PlatformReleaseGitHubClient['createRelease']>>>
  const releases = Object.fromEntries(REPOSITORY_KEYS.map((key) => [key, { url: releaseDetails[key].url }])) as PlatformReleaseApplyResult['releases']

  const manifest = createPlatformReleaseManifest({
    config: input.config,
    content,
    contentDigest,
    plan: input.plan,
    releases: releaseDetails,
    workflows,
  })
  const serializedManifest = serializePlatformReleaseManifest(manifest)
  await input.onManifest?.(serializedManifest)
  await Promise.all(REPOSITORY_KEYS.map((key) => github.ensureReleaseManifest({
    manifest: serializedManifest,
    repository: input.plan.repositories[key].repository,
    version: input.plan.version,
  })))
  const founderOpsResult = await founderOps.ingestManifest({
    manifest: serializedManifest,
    manifestDigest: manifest.manifestDigest,
  })

  const issues = new Map<string, PlatformReleasePlan['repositories']['website']['pullRequests'][number]['issues'][number]>()
  const releaseRepositories = new Set(REPOSITORY_KEYS.map((key) => input.config.repositories[key].repository))
  for (const repository of Object.values(input.plan.repositories)) {
    for (const pullRequest of repository.pullRequests) {
      for (const issue of pullRequest.issues) {
        if (releaseRepositories.has(issue.repository)) issues.set(`${issue.repository}#${issue.number}`, issue)
      }
    }
  }
  const marker = `<!-- findmydoc-platform-release:${input.plan.version} -->`
  for (const issue of issues.values()) {
    if (await github.findIssueComment({ issue, marker })) continue
    await github.addIssueComment({
      body: [
        marker,
        `Released with findmydoc ${input.plan.version}.`,
        '',
        `- [Public platform release](${releases.website.url})`,
        `- [Dashboard release](${releases.dashboard.url})`,
      ].join('\n'),
      issue,
    })
  }

  let announcement: PlatformReleaseApplyResult['announcement'] = 'skipped'
  if (input.announce) {
    announcement = await announcePlatformReleaseOnce({
      founderOpsUrl: founderOpsResult.url,
      manifest,
      webhook: input.webhook ?? '',
    }, github)
  }

  return {
    announcement,
    contentDigest,
    digest: input.plan.digest,
    founderOps: founderOpsResult,
    manifestDigest: manifest.manifestDigest,
    releases,
    status: 'published',
    version: input.plan.version,
    workflows,
  }
}
