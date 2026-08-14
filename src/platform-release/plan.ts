import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { canonicalJson, sha256 } from './canonical.js'
import { assertManualVersion, compareVersions, highestBump, nextVersion } from './semver.js'
import { boundedVisualCandidates } from './visuals.js'
import type {
  PlatformReleaseConfig,
  PlatformReleaseGitHubClient,
  PlatformReleasePlan,
  PlatformRepositoryKey,
  PlatformReleaseRepositoryPlan,
  ReleaseBump,
} from './types.js'

const REPOSITORY_KEYS: PlatformRepositoryKey[] = ['dashboard', 'website']

export function computePlanDigest(plan: Omit<PlatformReleasePlan, 'digest'> | PlatformReleasePlan): string {
  const { createdAt: _createdAt, digest: _digest, ...durable } = plan as PlatformReleasePlan
  return sha256(canonicalJson(durable))
}

export function validatePlatformReleasePlan(plan: PlatformReleasePlan): void {
  if (plan.schemaVersion !== 2) throw new Error('Unsupported platform release plan schema.')
  for (const key of REPOSITORY_KEYS) {
    if (!plan.repositories[key]?.pullRequests.every((pullRequest) => Array.isArray(pullRequest.commitShas))) {
      throw new Error(`Platform release plan ${key} pull request provenance is incomplete.`)
    }
  }
  const expected = computePlanDigest(plan)
  if (plan.digest !== expected) throw new Error(`Platform release plan digest mismatch: expected ${expected}.`)
}

export function validatePlanAgainstConfig(plan: PlatformReleasePlan, config: PlatformReleaseConfig): void {
  const plannedKeys = Object.keys(plan.repositories).sort()
  if (JSON.stringify(plannedKeys) !== JSON.stringify([...REPOSITORY_KEYS].sort())) {
    throw new Error('Frozen plan repositories do not match the trusted platform release configuration.')
  }
  for (const key of REPOSITORY_KEYS) {
    const planned = plan.repositories[key]
    const configured = config.repositories[key]
    const fields = ['branch', 'deploymentWorkflow', 'productionUrl', 'repository', 'surface'] as const
    for (const field of fields) {
      if (planned[field] !== configured[field]) {
        throw new Error(`Frozen plan ${key}.${field} does not match the trusted platform release configuration.`)
      }
    }
    if (planned.base.kind === 'cutover' && planned.base.sha !== configured.cutoverSha) {
      throw new Error(`Frozen plan ${key} cutover SHA does not match the trusted platform release configuration.`)
    }
  }
}

export function platformDeploymentWorkflowTitle(plan: PlatformReleasePlan, key: PlatformRepositoryKey): string {
  return `findmydoc ${plan.version} · ${plan.digest} · ${plan.repositories[key].targetSha}`
}

export async function readPlatformReleasePlan(path: string): Promise<PlatformReleasePlan> {
  const plan = JSON.parse(await readFile(resolve(path), 'utf8')) as PlatformReleasePlan
  validatePlatformReleasePlan(plan)
  return plan
}

export async function writePlatformReleasePlan(path: string, plan: PlatformReleasePlan): Promise<void> {
  const absolutePath = resolve(path)
  await mkdir(dirname(absolutePath), { recursive: true })
  await writeFile(absolutePath, `${JSON.stringify(plan, null, 2)}\n`, 'utf8')
}

function combinedBump(plans: PlatformReleaseRepositoryPlan[]): ReleaseBump {
  return highestBump(plans.flatMap((plan) => plan.commits))
}

export async function createPlatformReleasePlan(
  input: { config: PlatformReleaseConfig; manualVersion?: string },
  github: PlatformReleaseGitHubClient,
): Promise<PlatformReleasePlan> {
  const releases = await Promise.all(REPOSITORY_KEYS.map(async (key) => ({
    key,
    release: await github.getLatestRelease(input.config.repositories[key].repository),
  })))
  const releaseVersions = releases.flatMap(({ release }) => release ? [release.version] : [])
  const uniqueReleaseVersions = new Set(releaseVersions)
  if (uniqueReleaseVersions.size > 1) {
    throw new Error(`Application release versions have diverged: ${[...uniqueReleaseVersions].join(', ')}.`)
  }
  if (releases.some(({ release }) => !release) && releaseVersions.some((version) =>
    version !== input.config.platformBaselineVersion)) {
    throw new Error('Application releases are in a partial published state; resume the existing frozen plan.')
  }
  const currentVersion = releaseVersions.sort(compareVersions).at(-1) ?? input.config.platformBaselineVersion

  const entries = await Promise.all(REPOSITORY_KEYS.map(async (key): Promise<[PlatformRepositoryKey, PlatformReleaseRepositoryPlan]> => {
    const repositoryConfig = input.config.repositories[key]
    const latest = releases.find((entry) => entry.key === key)?.release
    const baseSha = latest?.sha ?? repositoryConfig.cutoverSha
    if (!baseSha) throw new Error(`${repositoryConfig.repository} has no release or configured cutover SHA.`)
    const targetSha = await github.getBranchSha(repositoryConfig.repository, repositoryConfig.branch)
    if (!await github.isAncestor(repositoryConfig.repository, baseSha, repositoryConfig.branch)) {
      throw new Error(`Baseline ${baseSha} is not an ancestor of ${repositoryConfig.repository}:${repositoryConfig.branch}.`)
    }
    const commits = baseSha === targetSha
      ? []
      : await github.compareCommits(repositoryConfig.repository, baseSha, targetSha)
    const pullRequests = await github.getPullRequests(repositoryConfig.repository, commits)
    return [key, {
      base: latest
        ? { kind: 'release', sha: latest.sha, version: latest.version }
        : { kind: 'cutover', sha: baseSha },
      branch: repositoryConfig.branch,
      commits,
      deploymentWorkflow: repositoryConfig.deploymentWorkflow,
      productionUrl: repositoryConfig.productionUrl,
      pullRequests,
      repository: repositoryConfig.repository,
      surface: repositoryConfig.surface,
      targetSha,
    }]
  }))
  const repositories = Object.fromEntries(entries) as PlatformReleasePlan['repositories']
  const bump = combinedBump(Object.values(repositories))
  if (bump === 'none') throw new Error('A release cannot be planned without changes in either application.')

  const breakingChanges = Object.values(repositories).flatMap((repository) => repository.commits
    .filter((commit) => commit.bump === 'major')
    .map((commit) => ({ message: commit.message, repository: repository.repository, sha: commit.sha })))
  if (breakingChanges.length > 0 && !input.manualVersion) {
    throw new Error('Breaking changes require an explicit manual platform version.')
  }

  const version = input.manualVersion ?? nextVersion(currentVersion, bump)
  if (input.manualVersion) assertManualVersion(input.manualVersion, currentVersion)
  const planWithoutDigest: Omit<PlatformReleasePlan, 'digest'> = {
    breakingChanges,
    createdAt: new Date().toISOString(),
    highestBump: bump,
    manualVersion: input.manualVersion !== undefined,
    repositories,
    schemaVersion: 2,
    version,
    visualCandidates: boundedVisualCandidates(Object.values(repositories).flatMap((repository) =>
      repository.pullRequests.flatMap((pullRequest) => pullRequest.visuals))),
  }
  return { ...planWithoutDigest, digest: computePlanDigest(planWithoutDigest) }
}
