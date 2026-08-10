import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { announcePlatformReleaseOnce } from './announce.js'
import { approvedReleaseVisuals, renderRepositoryReleaseNotes, validateReleaseNotes } from './notes.js'
import {
  platformDeploymentWorkflowTitle,
  validatePlanAgainstConfig,
  validatePlatformReleasePlan,
} from './plan.js'
import type {
  PlatformReleaseApplyResult,
  PlatformReleaseConfig,
  PlatformReleaseGitHubClient,
  PlatformReleasePlan,
  PlatformRepositoryKey,
  WorkflowRun,
} from './types.js'

const REPOSITORY_KEYS: PlatformRepositoryKey[] = ['dashboard', 'website']

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
    confirmDigest: string
    confirmVersion: string
    notes: string
    plan: PlatformReleasePlan
    webhook?: string
  },
  github: PlatformReleaseGitHubClient,
  options: { pollIntervalMs?: number; timeoutMs?: number } = {},
): Promise<PlatformReleaseApplyResult> {
  validatePlatformReleasePlan(input.plan)
  validatePlanAgainstConfig(input.plan, input.config)
  validateReleaseNotes(input.notes)
  const approvedVisuals = approvedReleaseVisuals(input.plan, input.notes)
  if (input.confirmDigest !== input.plan.digest) {
    throw new Error(`Digest confirmation must exactly match ${input.plan.digest}.`)
  }
  if (input.confirmVersion !== input.plan.version) {
    throw new Error(`Confirmation must exactly match ${input.plan.version}.`)
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

  const releaseEntries: Array<readonly [PlatformRepositoryKey, { url: string }]> = []
  for (const key of REPOSITORY_KEYS) {
    const repository = input.plan.repositories[key]
    const existing = await github.getRelease(repository.repository, input.plan.version)
    if (existing && existing.sha !== repository.targetSha) {
      throw new Error(`${repository.repository} ${input.plan.version} points to ${existing.sha}, not ${repository.targetSha}.`)
    }
    const release = existing ?? await github.createRelease({
      body: renderRepositoryReleaseNotes(input.plan, input.notes, key),
      repository: repository.repository,
      targetSha: repository.targetSha,
      version: input.plan.version,
    })
    releaseEntries.push([key, { url: release.url }])
  }
  const releases = Object.fromEntries(releaseEntries) as PlatformReleaseApplyResult['releases']

  const manifest = `${JSON.stringify({
    digest: input.plan.digest,
    repositories: Object.fromEntries(REPOSITORY_KEYS.map((key) => [key, {
      deploymentRun: workflows[key].url,
      release: releases[key].url,
      repository: input.plan.repositories[key].repository,
      targetSha: input.plan.repositories[key].targetSha,
    }])),
    schemaVersion: 1,
    version: input.plan.version,
  }, null, 2)}\n`
  await Promise.all(REPOSITORY_KEYS.map((key) => github.uploadReleaseManifest({
    manifest,
    repository: input.plan.repositories[key].repository,
    version: input.plan.version,
  })))

  const issues = new Map<string, PlatformReleasePlan['repositories']['website']['pullRequests'][number]['issues'][number]>()
  for (const repository of Object.values(input.plan.repositories)) {
    for (const pullRequest of repository.pullRequests) {
      for (const issue of pullRequest.issues) issues.set(`${issue.repository}#${issue.number}`, issue)
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
      notes: input.notes,
      plan: input.plan,
      releaseUrls: { dashboard: releases.dashboard.url, website: releases.website.url },
      visuals: approvedVisuals,
      webhook: input.webhook ?? '',
    }, github)
  }

  return {
    announcement,
    digest: input.plan.digest,
    releases,
    status: 'published',
    version: input.plan.version,
    workflows,
  }
}

export async function readApprovedReleaseNotes(path: string): Promise<string> {
  return readFile(resolve(path), 'utf8')
}
