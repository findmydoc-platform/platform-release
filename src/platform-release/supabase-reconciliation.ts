import { canonicalJson, sha256 } from './canonical.js'
import type {
  PlatformReleaseGitHubClient,
  PlatformReleasePlan,
  SupabaseReleaseBinding,
  SupabaseReleaseConfig,
  SupabaseReleaseContext,
  SupabaseReleaseRunStore,
  SupabaseReleaseAttestation,
  WorkflowArtifactBundle,
  WorkflowRun,
} from './types.js'

export const SUPABASE_MANAGED_FIELDS = [
  'hook_send_email_enabled',
  'hook_send_email_uri',
  'mailer_subjects_invite',
  'mailer_subjects_recovery',
  'mailer_templates_invite_content',
  'mailer_templates_recovery_content',
  'site_url',
  'uri_allow_list',
]
const HEX_SHA = /^[a-f0-9]{40}$/
const HEX_DIGEST = /^[a-f0-9]{64}$/
const ID = /^[a-z][a-z0-9-]{0,63}$/
const same = (left: unknown, right: unknown) => canonicalJson(left) === canonicalJson(right)

export function validateSupabaseReleaseConfig(config: SupabaseReleaseConfig): void {
  requireKeys(config, ['repository', 'branch', 'workflow'])
  if (
    !config ||
    config.repository !== 'findmydoc-platform/ops' ||
    config.branch !== 'main' ||
    config.workflow !== 'supabase-auth-config.yml'
  ) {
    throw new Error('Supabase reconciliation must use the trusted Ops main workflow.')
  }
}

export function validateSupabaseReleaseBinding(binding: SupabaseReleaseBinding): void {
  validateSupabaseReleaseConfig({ repository: binding.repository, branch: binding.branch, workflow: binding.workflow })
  requireKeys(binding, ['repository', 'branch', 'workflow', 'schemaVersion', 'opsSha', 'workflowDigest', 'targets'])
  if (
    binding.schemaVersion !== 1 ||
    !HEX_SHA.test(binding.opsSha) ||
    !HEX_DIGEST.test(binding.workflowDigest) ||
    !same(Object.keys(binding.targets ?? {}).sort(), ['preview', 'production'])
  ) {
    throw new Error('Frozen Ops reconciliation binding is invalid.')
  }
  for (const environment of ['preview', 'production'] as const) {
    const target = binding.targets[environment]
    requireKeys(target, ['instance', 'profile', 'projectRefDigest', 'managedFields'])
    if (
      !target ||
      target.instance !== (environment === 'preview' ? 'staging' : 'production') ||
      !ID.test(target.profile) ||
      !HEX_DIGEST.test(target.projectRefDigest) ||
      !same(target.managedFields, SUPABASE_MANAGED_FIELDS)
    )
      throw new Error('Frozen Ops target scope is invalid.')
  }
}

export async function bindSupabaseRelease(
  config: SupabaseReleaseConfig,
  github: PlatformReleaseGitHubClient,
): Promise<SupabaseReleaseBinding> {
  validateSupabaseReleaseConfig(config)
  try {
    return await readSupabaseBinding(config, github)
  } catch {
    throw new Error('Trusted Ops inventory could not be frozen; no release plan was created.')
  }
}

async function readSupabaseBinding(
  config: SupabaseReleaseConfig,
  github: PlatformReleaseGitHubClient,
): Promise<SupabaseReleaseBinding> {
  const opsSha = await github.getBranchSha(config.repository, config.branch)
  if (!HEX_SHA.test(opsSha) || !github.getRepositoryFile)
    throw new Error('Trusted immutable Ops source is unavailable.')
  const read = async (path: string) => {
    const content = await github.getRepositoryFile!(config.repository, path, opsSha)
    if (!content) throw new Error('Frozen Ops reconciliation source is unavailable.')
    return content
  }
  const workflow = await read(`.github/workflows/${config.workflow}`)
  const targets = {} as SupabaseReleaseBinding['targets']
  for (const environment of ['preview', 'production'] as const) {
    const instanceId = environment === 'preview' ? 'staging' : 'production'
    const instance = JSON.parse(await read(`config/supabase/instances/${instanceId}.json`))
    const allowed = [
      'version',
      'id',
      'profileId',
      'projectRef',
      'credentialId',
      'applyProtection',
      'authRouting',
      'nativeMailSuppression',
      'overrides',
    ]
    if (
      instance.version !== 1 ||
      instance.id !== instanceId ||
      !ID.test(instance.profileId) ||
      !/^[a-z]{20}$/.test(instance.projectRef) ||
      !instance.authRouting ||
      instance.nativeMailSuppression !== true ||
      instance.applyProtection !== (environment === 'preview' ? 'standard' : 'protected') ||
      Object.keys(instance).some((key) => !allowed.includes(key))
    )
      throw new Error('Ops release inventory does not match the supported managed scope.')
    const profile = JSON.parse(await read(`config/supabase/profiles/${instance.profileId}.json`))
    if (
      profile.version !== 1 ||
      profile.id !== instance.profileId ||
      !Array.isArray(profile.managedFields) ||
      !same(
        [...profile.managedFields].sort(),
        SUPABASE_MANAGED_FIELDS.filter((field) => field.startsWith('mailer_')),
      )
    ) {
      throw new Error('Ops release profile does not match the supported managed scope.')
    }
    targets[environment] = {
      instance: instanceId,
      profile: instance.profileId,
      projectRefDigest: sha256(instance.projectRef),
      managedFields: [...SUPABASE_MANAGED_FIELDS],
    }
  }
  const binding = { ...config, schemaVersion: 1 as const, opsSha, workflowDigest: sha256(workflow), targets }
  validateSupabaseReleaseBinding(binding)
  return binding
}

export function supabaseReleaseContext(
  plan: PlatformReleasePlan,
  contentDigest: string,
  environment: 'preview' | 'production',
): SupabaseReleaseContext {
  if (
    !plan.supabaseReconciliation ||
    !HEX_DIGEST.test(contentDigest) ||
    !HEX_DIGEST.test(plan.digest) ||
    !/^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(plan.version)
  )
    throw new Error('Frozen Ops release identity is unavailable.')
  return {
    schemaVersion: 1,
    environment,
    version: plan.version,
    planDigest: plan.digest,
    contentDigest,
    opsSha: plan.supabaseReconciliation.opsSha,
  }
}

function requireKeys(value: unknown, keys: string[]) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || !same(Object.keys(value).sort(), [...keys].sort()))
    throw new Error('Ops outcome schema is invalid.')
}

function validateFingerprint(value: { length: number; sha256: string }) {
  requireKeys(value, ['length', 'sha256'])
  if (!Number.isSafeInteger(value.length) || value.length < 0 || !HEX_DIGEST.test(value.sha256))
    throw new Error('Ops field fingerprint is invalid.')
}

export function validateSupabaseOutcome(
  binding: SupabaseReleaseBinding,
  context: SupabaseReleaseContext,
  run: WorkflowRun,
  bundle: WorkflowArtifactBundle,
): SupabaseReleaseAttestation['environments']['preview'] {
  if (
    !Number.isSafeInteger(bundle.id) ||
    bundle.id <= 0 ||
    !/^sha256:[a-f0-9]{64}$/.test(bundle.digest) ||
    bundle.name !== `supabase-auth-config-${run.databaseId}-${run.runAttempt}`
  )
    throw new Error('Ops artifact identity is invalid.')
  const expectedFiles = Object.keys(bundle.files)
    .filter((name) => name !== 'checksums.txt')
    .sort()
  const checksums = (bundle.files['checksums.txt'] ?? '').trim().split('\n')
  const listed: string[] = []
  for (const line of checksums) {
    const match = line.match(/^([a-f0-9]{64})  ([a-zA-Z0-9._-]+)$/)
    if (
      !match ||
      listed.includes(match[2]!) ||
      bundle.files[match[2]!] === undefined ||
      sha256(bundle.files[match[2]!]!) !== match[1]
    )
      throw new Error('Ops artifact checksums are invalid.')
    listed.push(match[2]!)
  }
  if (
    !same(listed.sort(), expectedFiles) ||
    !['operator-result.json', 'release-context.json', 'github-run.json'].every((name) => listed.includes(name))
  )
    throw new Error('Ops artifact evidence is incomplete.')
  const result = JSON.parse(bundle.files['operator-result.json']!)
  const metadata = JSON.parse(bundle.files['github-run.json']!)
  if (
    !same(JSON.parse(bundle.files['release-context.json']!), context) ||
    metadata.eventName !== 'workflow_dispatch' ||
    metadata.operation !== 'apply' ||
    metadata.operatorResultStatus !== 'present' ||
    metadata.opsRef !== binding.branch ||
    metadata.opsSha !== binding.opsSha ||
    metadata.repository !== binding.repository ||
    metadata.runId !== String(run.databaseId) ||
    metadata.runAttempt !== String(run.runAttempt) ||
    metadata.workflow !== 'Supabase Auth Config' ||
    metadata.job !== 'reconcile' ||
    !same(metadata.release, context)
  )
    throw new Error('Ops run metadata does not match the approved release.')
  requireKeys(result, ['schemaVersion', 'release', 'sourceSha', 'status', 'results'])
  if (
    result.schemaVersion !== 1 ||
    !same(result.release, context) ||
    result.sourceSha !== binding.opsSha ||
    !['applied', 'noop'].includes(result.status) ||
    !Array.isArray(result.results) ||
    result.results.length !== 1
  )
    throw new Error('Ops reconciliation has no verified apply outcome.')
  const target = binding.targets[context.environment]
  const instance = result.results[0]
  requireKeys(instance, ['instance', 'profile', 'projectRef', 'status', 'suppression', 'fields'])
  if (
    instance.instance !== target.instance ||
    metadata.instanceId !== target.instance ||
    instance.profile !== target.profile ||
    typeof instance.projectRef !== 'string' ||
    sha256(instance.projectRef) !== target.projectRefDigest ||
    instance.status !== result.status ||
    !same(instance.suppression, { functionMatches: true, permissionsMatch: true, status: 'converged' }) ||
    !Array.isArray(instance.fields) ||
    !same(instance.fields.map((field: { field: string }) => field.field).sort(), target.managedFields)
  )
    throw new Error('Ops managed target or scope did not converge.')
  for (const field of instance.fields) {
    requireKeys(field, ['field', 'status', 'desired', 'remote'])
    validateFingerprint(field.desired)
    validateFingerprint(field.remote)
    if (field.status !== 'converged' || !same(field.desired, field.remote))
      throw new Error('Ops managed fields did not converge.')
  }
  return {
    artifactId: bundle.id,
    artifactDigest: bundle.digest,
    artifactName: bundle.name,
    runId: run.databaseId,
    runAttempt: run.runAttempt!,
    runUrl: run.url,
    resultDigest: sha256(bundle.files['operator-result.json']!),
    managedFields: [...target.managedFields],
    status: 'verified',
  }
}

async function validateOpsRun(
  binding: SupabaseReleaseBinding,
  run: WorkflowRun,
  github: PlatformReleaseGitHubClient,
): Promise<void> {
  if (
    !Number.isSafeInteger(run.databaseId) ||
    run.databaseId <= 0 ||
    !Number.isSafeInteger(run.runAttempt) ||
    run.runAttempt! <= 0 ||
    run.event !== 'workflow_dispatch' ||
    run.headBranch !== binding.branch ||
    !HEX_SHA.test(run.headSha ?? '') ||
    run.path !== `.github/workflows/${binding.workflow}` ||
    run.displayTitle !== `Supabase Auth Config release apply ${run.databaseId}` ||
    run.url !== `https://github.com/${binding.repository}/actions/runs/${run.databaseId}` ||
    !(await github.isAncestor(binding.repository, run.headSha!, binding.branch)) ||
    sha256(
      (await github.getRepositoryFile!(binding.repository, `.github/workflows/${binding.workflow}`, run.headSha!)) ??
        '',
    ) !== binding.workflowDigest
  )
    throw new Error('Ops workflow run is not trusted frozen execution.')
}

export class SupabaseReconciliationError extends Error {
  constructor(
    readonly environment: 'preview' | 'production',
    message: string,
  ) {
    super(message)
  }
}

export async function inspectSupabaseRelease(
  plan: PlatformReleasePlan,
  github: PlatformReleaseGitHubClient,
  options: { contentDigest?: string; store?: SupabaseReleaseRunStore } = {},
) {
  const binding = plan.supabaseReconciliation
  if (!binding) return undefined
  validateSupabaseReleaseBinding(binding)
  const environments: Record<
    string,
    {
      phase: string
      runId?: number
      runAttempt?: number
      runUrl?: string
      evidence?: SupabaseReleaseAttestation['environments']['preview']
      problem?: string
    }
  > = {}
  for (const environment of ['preview', 'production'] as const) {
    if (!options.contentDigest || !options.store) {
      environments[environment] = { phase: 'unknown' }
      continue
    }
    try {
      const context = supabaseReleaseContext(plan, options.contentDigest, environment)
      const runId = await options.store.getRun(context)
      if (runId === undefined || runId === null) {
        environments[environment] = { phase: runId === null ? 'ambiguous' : 'pending' }
        continue
      }
      if (!github.getWorkflowRun || !github.getWorkflowArtifact || !github.getRepositoryFile)
        throw new Error('Ops evidence client is unavailable.')
      const run = await github.getWorkflowRun(binding.repository, runId)
      if (run.databaseId !== runId) throw new Error('Ops run identity changed.')
      await validateOpsRun(binding, run, github)
      const identity = { runId, runAttempt: run.runAttempt!, runUrl: run.url }
      if (run.status !== 'completed') {
        environments[environment] = { ...identity, phase: 'running' }
        continue
      }
      if (run.conclusion !== 'success') {
        environments[environment] = { ...identity, phase: 'failed' }
        continue
      }
      const bundle = await github.getWorkflowArtifact(
        binding.repository,
        run,
        `supabase-auth-config-${runId}-${run.runAttempt}`,
      )
      environments[environment] = {
        ...identity,
        phase: 'verified',
        evidence: validateSupabaseOutcome(binding, context, run, bundle),
      }
    } catch {
      environments[environment] = {
        phase: 'blocked',
        problem: `Ops ${environment} invocation evidence could not be verified.`,
      }
    }
  }
  return { fresh: false, opsSha: binding.opsSha, scope: binding.targets, environments }
}

export async function reconcileSupabaseRelease(
  plan: PlatformReleasePlan,
  contentDigest: string,
  github: PlatformReleaseGitHubClient,
  store: SupabaseReleaseRunStore,
  options: { allowDispatch?: boolean; pollIntervalMs?: number; timeoutMs?: number } = {},
): Promise<SupabaseReleaseAttestation> {
  const binding = plan.supabaseReconciliation
  if (!binding) throw new Error('Frozen Ops reconciliation binding is unavailable.')
  validateSupabaseReleaseBinding(binding)
  const environments = {} as SupabaseReleaseAttestation['environments']
  for (const environment of ['preview', 'production'] as const) {
    try {
      if (
        !github.getWorkflowRun ||
        !github.getWorkflowArtifact ||
        !github.dispatchWorkflowRun ||
        !github.getRepositoryFile ||
        !(await github.isAncestor(binding.repository, binding.opsSha, binding.branch)) ||
        sha256(
          (await github.getRepositoryFile(
            binding.repository,
            `.github/workflows/${binding.workflow}`,
            binding.opsSha,
          )) ?? '',
        ) !== binding.workflowDigest
      )
        throw new Error('Frozen Ops contract is unavailable.')
      const context = supabaseReleaseContext(plan, contentDigest, environment)
      let runId = await store.getRun(context)
      if (runId === null)
        throw new Error('Ops dispatch outcome is ambiguous; inspect the existing invocation before recovery.')
      if (runId === undefined) {
        if (options.allowDispatch === false)
          throw new Error('Published release lacks its original Ops reconciliation evidence.')
        const currentMainSha = await github.getBranchSha(binding.repository, binding.branch)
        if (
          !HEX_SHA.test(currentMainSha) ||
          currentMainSha !== binding.opsSha ||
          sha256(
            (await github.getRepositoryFile(
              binding.repository,
              `.github/workflows/${binding.workflow}`,
              currentMainSha,
            )) ?? '',
          ) !== binding.workflowDigest
        ) {
          throw new Error('Ops main changed after approval; a new frozen release plan is required.')
        }
        await store.begin(context)
        const dispatched = await github.dispatchWorkflowRun({
          repository: binding.repository,
          branch: binding.branch,
          workflow: binding.workflow,
          inputs: { operation: 'apply', apply_changes: 'true', release_context: JSON.stringify(context) },
        })
        if (
          !Number.isSafeInteger(dispatched.databaseId) ||
          dispatched.databaseId <= 0 ||
          dispatched.url !== `https://github.com/${binding.repository}/actions/runs/${dispatched.databaseId}`
        )
          throw new Error('Ops dispatch identity is invalid.')
        await store.recordRun(context, dispatched.databaseId)
        runId = dispatched.databaseId
      }
      const deadline = Date.now() + (options.timeoutMs ?? 45 * 60_000)
      let run: WorkflowRun
      for (;;) {
        run = await github.getWorkflowRun(binding.repository, runId)
        if (run.databaseId !== runId) throw new Error('Ops run identity changed.')
        await validateOpsRun(binding, run, github)
        if (run.status === 'completed') break
        if (Date.now() >= deadline) throw new Error('Ops reconciliation timed out.')
        await new Promise<void>((resolve) => setTimeout(resolve, options.pollIntervalMs ?? 10_000))
      }
      if (run.conclusion !== 'success') throw new Error('Ops reconciliation failed.')
      const bundle = await github.getWorkflowArtifact(
        binding.repository,
        run,
        `supabase-auth-config-${run.databaseId}-${run.runAttempt}`,
      )
      environments[environment] = validateSupabaseOutcome(binding, context, run, bundle)
    } catch {
      throw new SupabaseReconciliationError(
        environment,
        `Ops ${environment} reconciliation could not be verified; release mutations are stopped.`,
      )
    }
  }
  return {
    schemaVersion: 1,
    opsSha: binding.opsSha,
    planDigest: plan.digest,
    contentDigest,
    version: plan.version,
    environments,
  }
}
