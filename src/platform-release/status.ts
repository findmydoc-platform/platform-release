import { platformDeploymentWorkflowTitle, validatePlatformReleasePlan } from './plan.js'
import { authMailContext, validateAuthMailProgress } from './auth-mail.js'
import type { AuthMailRuntime } from './auth-mail.js'
import type { PlatformReleaseGitHubClient, PlatformReleasePlan, PlatformRepositoryKey } from './types.js'

const KEYS: PlatformRepositoryKey[] = ['dashboard', 'website']

export async function getPlatformReleaseStatus(
  plan: PlatformReleasePlan,
  github: PlatformReleaseGitHubClient,
  options: AuthMailRuntime & { contentDigest?: string } = {},
): Promise<unknown> {
  validatePlatformReleasePlan(plan)
  const entries = await Promise.all(
    KEYS.map(async (key) => {
      const repository = plan.repositories[key]
      const [deployment, release] = await Promise.all([
        github.findWorkflowRun({
          branch: repository.branch,
          repository: repository.repository,
          title: platformDeploymentWorkflowTitle(plan, key),
          workflow: repository.deploymentWorkflow,
        }),
        github.getRelease(repository.repository, plan.version),
      ])
      const releaseMatchesTargetSha = release ? release.sha === repository.targetSha : null
      return [
        key,
        {
          deployment: deployment ?? null,
          release: release ?? null,
          releaseMatchesTargetSha,
          repository: repository.repository,
          targetSha: repository.targetSha,
        },
      ] as const
    }),
  )
  const repositories = Object.fromEntries(entries) as Record<PlatformRepositoryKey, (typeof entries)[number][1]>
  const problems = KEYS.flatMap((key) => {
    const entry = repositories[key]
    return [
      ...(entry.releaseMatchesTargetSha === false
        ? [`${entry.repository} ${plan.version} does not point to ${entry.targetSha}.`]
        : []),
      ...(entry.release?.draft ? [`${entry.repository} ${plan.version} is still a draft.`] : []),
      ...(entry.release?.manifestAttached === false
        ? [`${entry.repository} ${plan.version} is missing platform-release.json.`]
        : []),
    ]
  })
  let authMail
  if (plan.authMail) {
    const progress =
      options.authMailState && options.contentDigest
        ? await options.authMailState.getState(authMailContext(plan, options.contentDigest))
        : undefined
    if (progress) validateAuthMailProgress(progress)
    authMail = {
      adapterAvailable: Boolean(options.authMail),
      binding: plan.authMail,
      fresh: false,
      rollback: progress?.rollback ?? false,
      state: progress?.state ?? 'preflight-pending',
    }
    if (!options.authMail) problems.push('Protected Website Auth mail runtime adapter is unavailable.')
    if (!options.contentDigest) problems.push('Auth mail state inspection requires the approved release content.')
  }
  return { ...(authMail ? { authMail } : {}), digest: plan.digest, problems, repositories, version: plan.version }
}
