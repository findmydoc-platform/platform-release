import { canonicalJson, sha256, stableValue } from './canonical.js'
import type {
  AuthMailCutoverConfig,
  AuthMailSuppressionBinding,
  PlatformReleaseGitHubClient,
  PlatformReleasePlan,
  PlatformRepositoryKey,
} from './types.js'

const DECLARATION_PATH = 'supabase/native-mail-suppression.json'
const ADR_PATH = 'docs/adrs/032-adr-supabase-native-mail-suppression.md'
const FUNCTION_FINGERPRINT = '4576724f01312619005205245a81bcb1756c257a6777b5c6399a8b807eeeb7af'
const PERMISSION_FINGERPRINT = '87bf0181149020c959b00de652c2506e11a682dcae5a0d6fa8bb06bcd5b14cfd'

// This is a closed validation contract for Website-owned source, never executable runner SQL.
const MIGRATION_CONTRACT = `begin;
create schema auth_mail_suppression;
create function auth_mail_suppression.send_email_v1(event jsonb)
returns jsonb
language sql
security invoker
set search_path = ''
as $function$
  select '{}'::jsonb;
$function$;
revoke all on schema auth_mail_suppression from public, anon, authenticated;
grant usage on schema auth_mail_suppression to supabase_auth_admin;
revoke all on function auth_mail_suppression.send_email_v1(jsonb) from public, anon, authenticated;
grant execute on function auth_mail_suppression.send_email_v1(jsonb) to supabase_auth_admin;
commit;`

export function validateAuthMailConfig(config: AuthMailCutoverConfig): void {
  if (
    !config ||
    Object.keys(config).sort().join(',') !== 'bindingId,workflow' ||
    !/^[a-z][a-z0-9-]{0,63}$/.test(config.bindingId) ||
    config.workflow !== 'platform-release-auth-mail.yml'
  ) {
    throw new Error('Invalid trusted Auth mail workflow configuration.')
  }
}

export function validateAuthMailBinding(binding: AuthMailSuppressionBinding, websiteSha: string): void {
  const { bindingId, workflow, ...fingerprints } = binding
  validateAuthMailConfig({ bindingId, workflow })
  if (
    Object.keys(fingerprints).sort().join(',') !==
      'adrDigest,declarationDigest,functionFingerprint,migrationDigest,permissionFingerprint,websiteSha' ||
    !/^[0-9a-f]{40}$/.test(websiteSha) ||
    binding.websiteSha !== websiteSha ||
    binding.functionFingerprint !== FUNCTION_FINGERPRINT ||
    binding.permissionFingerprint !== PERMISSION_FINGERPRINT ||
    ![binding.adrDigest, binding.declarationDigest, binding.migrationDigest].every((value) =>
      /^[0-9a-f]{64}$/.test(value),
    )
  ) {
    throw new Error('Invalid frozen Auth mail suppression binding.')
  }
}

export async function bindAuthMailSuppression(
  config: AuthMailCutoverConfig,
  website: { repository: string; targetSha: string },
  github: PlatformReleaseGitHubClient,
): Promise<AuthMailSuppressionBinding> {
  validateAuthMailConfig(config)
  if (!github.getRepositoryFile || !/^[0-9a-f]{40}$/.test(website.targetSha)) {
    throw new Error('Frozen Website suppression source is unavailable.')
  }
  const source = await github.getRepositoryFile(website.repository, DECLARATION_PATH, website.targetSha)
  let declaration: {
    version: number
    migration: string
    function: unknown
    permissions: unknown
    fingerprints: { function: string; permissions: string }
  }
  try {
    declaration = JSON.parse(source ?? '') as typeof declaration
    if (
      Object.keys(declaration).sort().join(',') !== 'fingerprints,function,migration,permissions,version' ||
      declaration.version !== 1 ||
      !/^migrations\/\d{14}_native_mail_suppression\.sql$/.test(declaration.migration) ||
      Object.keys(declaration.fingerprints).sort().join(',') !== 'function,permissions' ||
      declaration.fingerprints.function !== FUNCTION_FINGERPRINT ||
      declaration.fingerprints.permissions !== PERMISSION_FINGERPRINT ||
      sha256(JSON.stringify(stableValue(declaration.function))) !== FUNCTION_FINGERPRINT ||
      sha256(JSON.stringify(stableValue(declaration.permissions))) !== PERMISSION_FINGERPRINT
    )
      throw new Error()
  } catch {
    throw new Error('Frozen Website suppression declaration does not match the approved no-op contract.')
  }
  const [migration, adr] = await Promise.all([
    github.getRepositoryFile(website.repository, `supabase/${declaration.migration}`, website.targetSha),
    github.getRepositoryFile(website.repository, ADR_PATH, website.targetSha),
  ])
  if (
    migration?.trim().replace(/\s+/g, ' ') !== MIGRATION_CONTRACT.replace(/\s+/g, ' ') ||
    !adr ||
    !/\|\s*Status\s*\|\s*Approved\s*\|/.test(adr)
  ) {
    throw new Error('Frozen Website suppression migration or approved ADR is unavailable or inconsistent.')
  }
  return {
    ...config,
    adrDigest: sha256(adr),
    declarationDigest: sha256(canonicalJson(declaration)),
    functionFingerprint: FUNCTION_FINGERPRINT,
    migrationDigest: sha256(migration),
    permissionFingerprint: PERMISSION_FINGERPRINT,
    websiteSha: website.targetSha,
  }
}

export type AuthMailReleaseState =
  | 'preflight-pending'
  | 'cutover-ready'
  | 'cutover-applied'
  | 'deploying'
  | 'deployed'
  | 'release-pending'
  | 'published'
  | 'rollback-required'

export type AuthMailContext = {
  binding: AuthMailSuppressionBinding
  contentDigest: string
  planDigest: string
  previousShas: Record<PlatformRepositoryKey, string>
  version: string
}

export type AuthMailEvidence = {
  bindingDigest: string
  contentDigest: string
  customSmtpConfigured: false
  deliveredEmails: 0
  emailProviderEnabled: true
  environment: 'production'
  functionFingerprint: string
  hookEnabled: boolean
  hookIdentity: 'auth_mail_suppression.send_email_v1(jsonb)' | null
  nativeMailCheck: 'not-run' | 'suppressed'
  networkRequests: 0
  permissionFingerprint: string
  permissionVerified: true
  planDigest: string
  schemaExposed: false
}

// The Website-owned protected runtime adapter is an external prerequisite, not implemented here.
export type AuthMailCutoverClient = {
  preflight(context: AuthMailContext): Promise<unknown>
  cutover(context: AuthMailContext): Promise<unknown>
  rollback?(context: AuthMailContext): Promise<unknown>
  verifyRollback?(context: AuthMailContext): Promise<unknown>
}

export type AuthMailProgress = { rollback: boolean; state: AuthMailReleaseState }
export type AuthMailStateStore = {
  getState(context: AuthMailContext): Promise<AuthMailProgress | undefined>
  setState(context: AuthMailContext, progress: AuthMailProgress): Promise<void>
}

export type AuthMailRuntime = { authMail?: AuthMailCutoverClient; authMailState?: AuthMailStateStore }

export function validateAuthMailProgress(value: unknown): AuthMailProgress {
  const progress = value as AuthMailProgress
  const states: AuthMailReleaseState[] = [
    'preflight-pending',
    'cutover-ready',
    'cutover-applied',
    'deploying',
    'deployed',
    'release-pending',
    'published',
    'rollback-required',
  ]
  if (
    !progress ||
    typeof progress !== 'object' ||
    Array.isArray(progress) ||
    Object.keys(progress).sort().join(',') !== 'rollback,state' ||
    !states.includes(progress.state) ||
    typeof progress.rollback !== 'boolean' ||
    (progress.rollback && progress.state !== 'rollback-required')
  ) {
    throw new Error('Stored Auth mail release state is invalid.')
  }
  return progress
}

export function authMailContext(plan: PlatformReleasePlan, contentDigest: string): AuthMailContext {
  if (!plan.authMail) throw new Error('The frozen plan has no Auth mail suppression binding.')
  return {
    binding: plan.authMail,
    contentDigest,
    planDigest: plan.digest,
    version: plan.version,
    previousShas: { dashboard: plan.repositories.dashboard.base.sha, website: plan.repositories.website.base.sha },
  }
}

export function computeAuthMailRollbackDigest(plan: PlatformReleasePlan, contentDigest: string): string {
  const context = authMailContext(plan, contentDigest)
  if (!Object.values(context.previousShas).every((sha) => /^[0-9a-f]{40}$/.test(sha))) {
    throw new Error('Rollback requires frozen full pre-release application SHAs.')
  }
  return sha256(canonicalJson({ ...context, binding: sha256(canonicalJson(context.binding)) }))
}

export function validateAuthMailRollbackEvidence(
  candidate: unknown,
  context: AuthMailContext,
  restored: boolean,
): void {
  const evidence = candidate as {
    suppression: unknown
    authCommandsDisabled: boolean
    otherCommandsUnchanged: boolean
    applicationShas?: unknown
  }
  if (
    !evidence ||
    typeof evidence !== 'object' ||
    Array.isArray(evidence) ||
    Object.keys(evidence).sort().join(',') !==
      (restored
        ? 'applicationShas,authCommandsDisabled,otherCommandsUnchanged,suppression'
        : 'authCommandsDisabled,otherCommandsUnchanged,suppression') ||
    evidence.authCommandsDisabled !== true ||
    evidence.otherCommandsUnchanged !== true ||
    (restored && canonicalJson(evidence.applicationShas) !== canonicalJson(context.previousShas))
  ) {
    throw new AuthMailCutoverError(
      'rollback-required',
      'Protected Website rollback evidence is missing or inconsistent.',
    )
  }
  if (!validateAuthMailEvidence(evidence.suppression, context).hookEnabled) {
    throw new AuthMailCutoverError('rollback-required', 'Rollback must retain verified Auth mail suppression.')
  }
}

export class AuthMailCutoverError extends Error {
  constructor(
    readonly state: AuthMailReleaseState,
    message: string,
  ) {
    super(message)
  }
}

function requireClient(client: AuthMailCutoverClient | undefined): AuthMailCutoverClient {
  if (!client)
    throw new AuthMailCutoverError(
      'preflight-pending',
      'The protected Website Auth mail adapter is unavailable; no Production mutation is permitted.',
    )
  return client
}

export function validateAuthMailEvidence(candidate: unknown, context: AuthMailContext): AuthMailEvidence {
  const evidence = candidate as AuthMailEvidence
  if (
    !evidence ||
    typeof evidence !== 'object' ||
    Array.isArray(evidence) ||
    Object.keys(evidence).sort().join(',') !==
      'bindingDigest,contentDigest,customSmtpConfigured,deliveredEmails,emailProviderEnabled,environment,functionFingerprint,hookEnabled,hookIdentity,nativeMailCheck,networkRequests,permissionFingerprint,permissionVerified,planDigest,schemaExposed' ||
    evidence.bindingDigest !== sha256(canonicalJson(context.binding)) ||
    evidence.contentDigest !== context.contentDigest ||
    evidence.planDigest !== context.planDigest ||
    evidence.environment !== 'production' ||
    evidence.permissionVerified !== true ||
    evidence.emailProviderEnabled !== true ||
    evidence.customSmtpConfigured !== false ||
    evidence.schemaExposed !== false ||
    evidence.functionFingerprint !== context.binding.functionFingerprint ||
    evidence.permissionFingerprint !== context.binding.permissionFingerprint ||
    typeof evidence.hookEnabled !== 'boolean' ||
    ![null, 'auth_mail_suppression.send_email_v1(jsonb)'].includes(evidence.hookIdentity) ||
    evidence.networkRequests !== 0 ||
    evidence.deliveredEmails !== 0 ||
    (evidence.hookEnabled
      ? evidence.hookIdentity === null || evidence.nativeMailCheck !== 'suppressed'
      : evidence.nativeMailCheck !== 'not-run')
  ) {
    throw new AuthMailCutoverError(
      'preflight-pending',
      'Protected Website Auth mail evidence is missing or inconsistent.',
    )
  }
  return evidence
}

export async function assertAuthMailApplied(
  context: AuthMailContext,
  client?: AuthMailCutoverClient,
): Promise<AuthMailEvidence> {
  try {
    const evidence = validateAuthMailEvidence(await requireClient(client).preflight(context), context)
    if (!evidence.hookEnabled) throw new Error()
    return evidence
  } catch {
    throw new AuthMailCutoverError(
      'rollback-required',
      'Auth mail suppression cannot be verified; Production mutations are stopped.',
    )
  }
}

export async function prepareAuthMailCutover(
  context: AuthMailContext,
  client?: AuthMailCutoverClient,
): Promise<{
  evidence: AuthMailEvidence
  state: 'cutover-applied'
}> {
  const adapter = requireClient(client)
  let before: AuthMailEvidence
  try {
    before = validateAuthMailEvidence(await adapter.preflight(context), context)
  } catch {
    throw new AuthMailCutoverError(
      'preflight-pending',
      'Auth mail preflight failed; no Production mutation is permitted.',
    )
  }
  if (before.hookEnabled) return { evidence: before, state: 'cutover-applied' }
  try {
    const applied = validateAuthMailEvidence(await adapter.cutover(context), context)
    if (!applied.hookEnabled) throw new Error()
    return { evidence: await assertAuthMailApplied(context, adapter), state: 'cutover-applied' }
  } catch {
    throw new AuthMailCutoverError(
      'rollback-required',
      'Auth mail cutover was attempted but cannot be confirmed; operator recovery is required.',
    )
  }
}
