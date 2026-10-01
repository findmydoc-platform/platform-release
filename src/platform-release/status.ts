import { platformDeploymentWorkflowTitle } from './plan.js'
import { inspectSupabaseRelease } from './supabase-reconciliation.js'
import type {
  PlatformReleaseGitHubClient,
  PlatformReleasePlan,
  PlatformRepositoryKey,
  SupabaseReleaseRunStore,
} from './types.js'

const KEYS: PlatformRepositoryKey[] = ['dashboard', 'website']

export async function getPlatformReleaseStatus(
  plan: PlatformReleasePlan,
  github: PlatformReleaseGitHubClient,
  options: { contentDigest?: string; supabaseRunStore?: SupabaseReleaseRunStore } = {},
): Promise<unknown> {
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
  const reconciliation = await inspectSupabaseRelease(plan, github, {
    contentDigest: options.contentDigest,
    store: options.supabaseRunStore,
  })
  if (reconciliation)
    for (const state of Object.values(reconciliation.environments)) {
      if (state.problem) problems.push(state.problem)
    }
  return {
    digest: plan.digest,
    problems,
    repositories,
    version: plan.version,
    ...(reconciliation ? { reconciliation } : {}),
  }
}
