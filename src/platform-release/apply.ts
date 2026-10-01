import { announcePlatformReleaseOnce } from './announce.js'
import { computeReleaseContentDigest, renderRepositoryReleaseNotes, validateReleaseContent } from './content.js'
import { createPlatformReleaseManifestV3, serializeReleaseManifest } from './manifest.js'
import {
  assertAuthMailApplied,
  authMailContext,
  AuthMailCutoverError,
  computeAuthMailRollbackDigest,
  prepareAuthMailCutover,
  validateAuthMailRollbackEvidence,
} from './auth-mail.js'
import type { AuthMailReleaseState, AuthMailRuntime } from './auth-mail.js'
import { platformDeploymentWorkflowTitle, validatePlanAgainstConfig, validatePlatformReleasePlan } from './plan.js'
import type {
  PlatformReleaseApplyResult,
  PlatformReleaseConfig,
  PlatformReleaseContent,
  PlatformReleaseAnnouncementStore,
  FounderOpsReleaseClient,
  PlatformReleaseGitHubClient,
  PlatformReleasePlan,
  PlatformRepositoryKey,
  WorkflowRun,
} from './types.js'

const REPOSITORY_KEYS: PlatformRepositoryKey[] = ['dashboard', 'website']
const RELEASE_METADATA_MARKER =
  /\n*<!--\s*findmydoc-platform-(?:announcement:(?:pending|sent)|published-at:[^\s>]+)\s*-->\s*$/

export function releaseNotesBody(body: string): string {
  let value = body
  while (RELEASE_METADATA_MARKER.test(value)) value = value.replace(RELEASE_METADATA_MARKER, '')
  return value.trim()
}

export async function rollbackPlatformRelease(
  input: {
    apply: boolean
    config: PlatformReleaseConfig
    confirmContentDigest?: string
    confirmDigest?: string
    confirmRollbackDigest?: string
    confirmVersion?: string
    content: PlatformReleaseContent
    plan: PlatformReleasePlan
  },
  github: PlatformReleaseGitHubClient,
  options: AuthMailRuntime & {
    pollIntervalMs?: number
    timeoutMs?: number
  } = {},
) {
  validatePlatformReleasePlan(input.plan)
  validatePlanAgainstConfig(input.plan, input.config, true)
  const contentDigest = computeReleaseContentDigest(validateReleaseContent(input.plan, input.content))
  const context = authMailContext(input.plan, contentDigest)
  const rollbackDigest = computeAuthMailRollbackDigest(input.plan, contentDigest)
  if (input.apply) {
    if (
      input.confirmDigest !== input.plan.digest ||
      input.confirmContentDigest !== contentDigest ||
      input.confirmVersion !== input.plan.version
    ) {
      throw new Error('Rollback requires exact approved plan, content and version confirmations.')
    }
    if (input.confirmRollbackDigest !== rollbackDigest)
      throw new Error('Rollback digest confirmation must exactly match the frozen rollback identity.')
  }
  if (!options.authMail?.rollback || !options.authMail.verifyRollback || !options.authMailState) {
    throw new AuthMailCutoverError(
      'preflight-pending',
      'The protected Website rollback adapter is unavailable; no Production mutation is permitted.',
    )
  }
  for (const key of REPOSITORY_KEYS) {
    const repository = input.plan.repositories[key]
    const release = await github.getRelease(repository.repository, input.plan.version)
    if (release && !release.draft)
      throw new Error('A published version cannot be rolled back; prepare a corrective platform release.')
    if (!(await github.isAncestor(repository.repository, context.previousShas[key], repository.branch))) {
      throw new Error('Frozen pre-release application SHA is no longer reachable; rollback is stopped.')
    }
  }
  await options.authMailState.getState(context)
  await assertAuthMailApplied(context, options.authMail)
  const result = {
    contentDigest,
    planDigest: input.plan.digest,
    previousShas: context.previousShas,
    rollbackDigest,
    version: input.plan.version,
  }
  if (!input.apply) return { ...result, status: 'ready' as const }

  await options.authMailState.setState(context, { rollback: true, state: 'rollback-required' })
  try {
    validateAuthMailRollbackEvidence(await options.authMail.rollback(context), context, false)
    const rollbackPlan: PlatformReleasePlan = {
      ...input.plan,
      repositories: {
        dashboard: { ...input.plan.repositories.dashboard, targetSha: context.previousShas.dashboard },
        website: { ...input.plan.repositories.website, targetSha: context.previousShas.website },
      },
    }
    const workflows = {} as Record<PlatformRepositoryKey, WorkflowRun>
    for (const key of REPOSITORY_KEYS) {
      workflows[key] = await ensureDeployment(rollbackPlan, key, github, {
        beforeMutation: async () => {
          await assertAuthMailApplied(context, options.authMail)
        },
        pollIntervalMs: options.pollIntervalMs ?? 10_000,
        timeoutMs: options.timeoutMs ?? 45 * 60_000,
      })
    }
    validateAuthMailRollbackEvidence(await options.authMail.verifyRollback(context), context, true)
    return { ...result, status: 'rolled-back' as const, workflows }
  } catch {
    throw new AuthMailCutoverError(
      'rollback-required',
      'Explicit rollback could not be verified; suppression must remain active and Auth commands disabled.',
    )
  }
}

const delay = (milliseconds: number) => new Promise<void>((resolveDelay) => setTimeout(resolveDelay, milliseconds))

async function waitForWorkflow(
  plan: PlatformReleasePlan,
  key: PlatformRepositoryKey,
  github: PlatformReleaseGitHubClient,
  options: { beforeMutation?: () => Promise<void>; pollIntervalMs: number; timeoutMs: number },
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
  options: { allowDispatch?: boolean; beforeMutation?: () => Promise<void>; pollIntervalMs: number; timeoutMs: number },
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
    if (options.allowDispatch === false)
      throw new Error('Published release deployment evidence is incomplete; corrective recovery is required.')
    if (existing?.conclusion !== 'success') ignoreRunId = existing?.databaseId
    await options.beforeMutation?.()
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
  announcementStore: PlatformReleaseAnnouncementStore,
  options: AuthMailRuntime & {
    now?: () => Date
    pollIntervalMs?: number
    timeoutMs?: number
  } = {},
): Promise<PlatformReleaseApplyResult> {
  validatePlatformReleasePlan(input.plan)
  validatePlanAgainstConfig(input.plan, input.config, true)
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
    if (!(await github.isAncestor(repository.repository, repository.targetSha, repository.branch))) {
      throw new Error(
        `Frozen target ${repository.targetSha} is no longer reachable from ${repository.repository}:${repository.branch}.`,
      )
    }
  }

  const context = input.plan.authMail ? authMailContext(input.plan, contentDigest) : undefined
  if (context && !options.authMail) {
    throw new AuthMailCutoverError(
      'preflight-pending',
      'The protected Website Auth mail adapter is unavailable; no Production mutation is permitted.',
    )
  }
  if (context && !options.authMailState)
    throw new AuthMailCutoverError('preflight-pending', 'Durable Auth mail release state is unavailable.')
  const progress = context ? await options.authMailState!.getState(context) : undefined
  if (progress?.rollback)
    throw new AuthMailCutoverError(
      'rollback-required',
      'This plan was explicitly rolled back; prepare a corrective platform release.',
    )
  const setState = async (state: AuthMailReleaseState) => {
    if (context) {
      try {
        await options.authMailState!.setState(context, { rollback: false, state })
      } catch {
        throw new AuthMailCutoverError(
          'rollback-required',
          'Auth mail release state cannot advance; Production mutations are stopped.',
        )
      }
    }
  }
  const beforeMutation = async () => {
    if (context) {
      await assertAuthMailApplied(context, options.authMail)
      if ((await options.authMailState!.getState(context))?.rollback)
        throw new AuthMailCutoverError(
          'rollback-required',
          'Explicit rollback stopped this running apply; Production mutations are stopped.',
        )
    }
  }
  let hasPublishedComponent = false
  const publishedComponents = new Set<PlatformRepositoryKey>()
  if (context) {
    for (const key of REPOSITORY_KEYS) {
      const release = await github.getRelease(input.plan.repositories[key].repository, input.plan.version)
      if (!release) continue
      if (
        release.sha !== input.plan.repositories[key].targetSha ||
        releaseNotesBody(release.body) !== renderRepositoryReleaseNotes(input.plan, content, key).trim()
      )
        throw new AuthMailCutoverError(
          'preflight-pending',
          'Existing release conflicts with the frozen approved plan or content.',
        )
      if (!release.draft) {
        hasPublishedComponent = true
        publishedComponents.add(key)
        if (release.immutable && !release.manifestAttached)
          throw new AuthMailCutoverError(
            'published',
            'An immutable release lacks its manifest; use artifact recovery or a corrective release.',
          )
      }
    }
  }
  let publicationAttempted = hasPublishedComponent
  const recoveryState = (): AuthMailReleaseState =>
    progress?.state === 'published' || publishedComponents.size === 2
      ? 'published'
      : publicationAttempted
        ? 'release-pending'
        : 'rollback-required'
  if (context) {
    // A persisted ambiguous state survives interruption during a cutover attempt.
    if (!progress) await setState('preflight-pending')
    const adapter = options.authMail!
    try {
      if (hasPublishedComponent || (progress && !['preflight-pending', 'cutover-ready'].includes(progress.state)))
        await assertAuthMailApplied(context, adapter)
      else
        await prepareAuthMailCutover(context, {
          preflight: async (request) => adapter.preflight(request),
          cutover: async (request) => {
            await setState('cutover-ready')
            await setState('rollback-required')
            return adapter.cutover(request)
          },
        })
    } catch (error) {
      if (progress && !['preflight-pending', 'cutover-ready'].includes(progress.state)) {
        await setState(recoveryState())
        throw new AuthMailCutoverError(
          recoveryState(),
          'Auth mail resume preflight failed; Production mutations are stopped.',
        )
      }
      throw error
    }
    if (!hasPublishedComponent) await setState('cutover-applied')
  }

  try {
    const workflowOptions = {
      allowDispatch: !hasPublishedComponent,
      beforeMutation,
      pollIntervalMs: options.pollIntervalMs ?? 10_000,
      timeoutMs: options.timeoutMs ?? 45 * 60_000,
    }
    if (!hasPublishedComponent) await setState('deploying')
    const workflowEntries: Array<readonly [PlatformRepositoryKey, WorkflowRun]> = []
    if (context) {
      for (const key of REPOSITORY_KEYS)
        workflowEntries.push([key, await ensureDeployment(input.plan, key, github, workflowOptions)])
    } else {
      workflowEntries.push(
        ...(await Promise.all(
          REPOSITORY_KEYS.map(
            async (key) => [key, await ensureDeployment(input.plan, key, github, workflowOptions)] as const,
          ),
        )),
      )
    }
    const workflows = Object.fromEntries(workflowEntries) as PlatformReleaseApplyResult['workflows']
    if (!hasPublishedComponent) await setState('deployed')
    if (publishedComponents.size !== 2) await setState('release-pending')

    const releaseEntries: Array<
      readonly [PlatformRepositoryKey, Awaited<ReturnType<PlatformReleaseGitHubClient['createDraftRelease']>>]
    > = []
    for (const key of REPOSITORY_KEYS) {
      const repository = input.plan.repositories[key]
      const expectedBody = renderRepositoryReleaseNotes(input.plan, content, key)
      const existing = await github.getRelease(repository.repository, input.plan.version)
      if (existing && existing.sha !== repository.targetSha) {
        throw new Error(
          `${repository.repository} ${input.plan.version} points to ${existing.sha}, not ${repository.targetSha}.`,
        )
      }
      if (existing && !existing.draft && existing.immutable && !existing.manifestAttached) {
        throw new Error(
          `${repository.repository} ${input.plan.version} is immutable and missing platform-release.json; publish a new platform version after fixing the runner.`,
        )
      }
      if (existing && releaseNotesBody(existing.body) !== expectedBody.trim()) {
        throw new Error(
          `${repository.repository} ${input.plan.version} release notes do not match the approved content.`,
        )
      }
      if (!existing) await beforeMutation()
      const release =
        existing ??
        (await github.createDraftRelease({
          body: expectedBody,
          repository: repository.repository,
          targetSha: repository.targetSha,
          version: input.plan.version,
        }))
      releaseEntries.push([key, release])
    }
    const releaseDetails = Object.fromEntries(releaseEntries) as Record<
      PlatformRepositoryKey,
      Awaited<ReturnType<PlatformReleaseGitHubClient['createDraftRelease']>>
    >
    const existingPlatformPublishedAt = [
      ...new Set(
        REPOSITORY_KEYS.flatMap((key) =>
          releaseDetails[key].platformPublishedAt ? [releaseDetails[key].platformPublishedAt] : [],
        ),
      ),
    ]
    if (existingPlatformPublishedAt.length > 1) {
      throw new Error(`${input.plan.version} releases have conflicting platform publication metadata.`)
    }
    const platformPublishedAt = existingPlatformPublishedAt[0] ?? (options.now ?? (() => new Date()))().toISOString()
    for (const key of REPOSITORY_KEYS) {
      const release = releaseDetails[key]
      if (release.platformPublishedAt === platformPublishedAt) continue
      if (!release.draft) {
        throw new Error(
          `${input.plan.repositories[key].repository} ${input.plan.version} is published without stable platform publication metadata.`,
        )
      }
      await beforeMutation()
      releaseDetails[key] = await github.setReleasePlatformPublishedAt({
        platformPublishedAt,
        releaseId: release.id,
        repository: input.plan.repositories[key].repository,
        version: input.plan.version,
      })
    }

    const manifest = createPlatformReleaseManifestV3({
      config: input.config,
      content,
      contentDigest,
      plan: input.plan,
      releases: releaseDetails,
      workflows,
    })
    const serializedManifest = serializeReleaseManifest(manifest)
    await input.onManifest?.(serializedManifest)
    for (const key of REPOSITORY_KEYS) {
      await beforeMutation()
      await github.ensureReleaseManifest({
        manifest: serializedManifest,
        repository: input.plan.repositories[key].repository,
        version: input.plan.version,
      })
    }
    for (const key of REPOSITORY_KEYS) {
      const release = releaseDetails[key]
      if (release.draft) {
        await beforeMutation()
        publicationAttempted = true
        await github.publishRelease({
          releaseId: release.id,
          repository: input.plan.repositories[key].repository,
          targetSha: input.plan.repositories[key].targetSha,
          version: input.plan.version,
        })
      }
      const published = await github.getRelease(input.plan.repositories[key].repository, input.plan.version)
      if (!published)
        throw new Error(
          `${input.plan.repositories[key].repository} ${input.plan.version} is missing after publication.`,
        )
      releaseDetails[key] = published
      if (releaseDetails[key].draft || !releaseDetails[key].publishedAt || !releaseDetails[key].manifestAttached) {
        throw new Error(
          `${input.plan.repositories[key].repository} ${input.plan.version} is not published with its manifest.`,
        )
      }
      publishedComponents.add(key)
    }
    const releases = Object.fromEntries(
      REPOSITORY_KEYS.map((key) => [key, { url: releaseDetails[key].url }]),
    ) as PlatformReleaseApplyResult['releases']
    await setState('published')
    await beforeMutation()
    const founderOpsResult = await founderOps.ingestManifest({
      manifest: serializedManifest,
      manifestDigest: manifest.manifestDigest,
    })

    let announcement: PlatformReleaseApplyResult['announcement'] = 'skipped'
    if (input.announce) {
      await beforeMutation()
      announcement = await announcePlatformReleaseOnce(
        {
          founderOpsUrl: founderOpsResult.url,
          manifest,
          webhook: input.webhook ?? '',
        },
        github,
        announcementStore,
      )
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
  } catch (error) {
    if (!context) throw error
    await setState(recoveryState())
    throw new AuthMailCutoverError(
      recoveryState(),
      'Platform release stopped after Auth mail cutover; operator recovery is required.',
    )
  }
}
