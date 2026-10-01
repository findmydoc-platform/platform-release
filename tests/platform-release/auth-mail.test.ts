import { describe, expect, it } from 'vitest'
import { bindAuthMailSuppression, prepareAuthMailCutover } from '../../src/platform-release/auth-mail.js'
import { canonicalJson, sha256 } from '../../src/platform-release/canonical.js'
import { createPlatformReleasePlan, validatePlatformReleasePlan } from '../../src/platform-release/plan.js'
import type { PlatformReleaseGitHubClient } from '../../src/platform-release/types.js'
import { suppressionBinding, suppressionEvidence } from './auth-mail-fixtures.js'

const websiteSha = 'a'.repeat(40)
const declaration = {
  version: 1,
  migration: 'migrations/20261001103540_native_mail_suppression.sql',
  function: {
    schema: 'auth_mail_suppression',
    name: 'send_email_v1',
    argument: { name: 'event', type: 'jsonb' },
    returns: 'jsonb',
    language: 'sql',
    security: 'invoker',
    searchPath: [],
    body: "select '{}'::jsonb;",
  },
  permissions: {
    schema: { usage: ['supabase_auth_admin'], create: [] },
    function: { execute: ['supabase_auth_admin'] },
    revoked: ['PUBLIC', 'anon', 'authenticated'],
    grantOption: false,
  },
  fingerprints: {
    function: '4576724f01312619005205245a81bcb1756c257a6777b5c6399a8b807eeeb7af',
    permissions: '87bf0181149020c959b00de652c2506e11a682dcae5a0d6fa8bb06bcd5b14cfd',
  },
}
const migration = `begin;
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
const adr = '# ADR: Supabase native-mail suppression\n| Status | Approved |\n'

function sourceGitHub(files: Record<string, string> = {}) {
  const source = {
    'supabase/native-mail-suppression.json': JSON.stringify(declaration),
    [`supabase/${declaration.migration}`]: migration,
    'docs/adrs/032-adr-supabase-native-mail-suppression.md': adr,
    ...files,
  }
  const reads: Array<{ path: string; sha: string }> = []
  return {
    reads,
    async getRepositoryFile(_repository: string, path: string, sha: string) {
      reads.push({ path, sha })
      return source[path as keyof typeof source]
    },
  } as unknown as PlatformReleaseGitHubClient & { reads: Array<{ path: string; sha: string }> }
}

describe('Auth mail release binding', () => {
  it.each([
    { environment: 'preview' },
    { permissionVerified: false },
    { emailProviderEnabled: false },
    { customSmtpConfigured: true },
    { schemaExposed: true },
    { hookIdentity: 'unknown' },
    { functionFingerprint: '0'.repeat(64) },
    { permissionFingerprint: '0'.repeat(64) },
    { nativeMailCheck: 'not-run' },
    { networkRequests: 1 },
    { deliveredEmails: 1 },
    { recipient: 'forbidden' },
    { contentDigest: '0'.repeat(64) },
  ])('blocks inconsistent runtime evidence %j before cutover', async (change) => {
    const context = {
      binding: suppressionBinding,
      contentDigest: 'd'.repeat(64),
      planDigest: 'e'.repeat(64),
      version: 'v0.46.0',
      previousShas: { dashboard: 'b'.repeat(40), website: 'c'.repeat(40) },
    }
    let cutover = false
    await expect(
      prepareAuthMailCutover(context, {
        async preflight() {
          return { ...suppressionEvidence(context), ...change }
        },
        async cutover() {
          cutover = true
        },
      }),
    ).rejects.toMatchObject({ state: 'preflight-pending' })
    expect(cutover).toBe(false)
  })

  it('preserves an ambiguous cutover failure for explicitly gated recovery', async () => {
    const context = {
      binding: suppressionBinding,
      contentDigest: 'd'.repeat(64),
      planDigest: 'e'.repeat(64),
      version: 'v0.46.0',
      previousShas: { dashboard: 'b'.repeat(40), website: 'c'.repeat(40) },
    }
    await expect(
      prepareAuthMailCutover(context, {
        async preflight() {
          return suppressionEvidence(context, false)
        },
        async cutover() {
          throw new Error('sensitive upstream diagnostic')
        },
      }),
    ).rejects.toMatchObject({
      state: 'rollback-required',
      message: 'Auth mail cutover was attempted but cannot be confirmed; operator recovery is required.',
    })
  })
  it('applies a ready no-op cutover and verifies its enabled state again', async () => {
    const binding = await bindAuthMailSuppression(
      { bindingId: 'website-production', workflow: 'platform-release-auth-mail.yml' },
      { repository: 'findmydoc-platform/website', targetSha: websiteSha },
      sourceGitHub(),
    )
    let enabled = false
    let readbacks = 0
    const context = {
      binding,
      contentDigest: 'd'.repeat(64),
      planDigest: 'e'.repeat(64),
      version: 'v0.46.0',
      previousShas: { dashboard: 'b'.repeat(40), website: 'c'.repeat(40) },
    }
    const evidence = () => ({
      bindingDigest: sha256(canonicalJson(binding)),
      environment: 'production',
      permissionVerified: true,
      emailProviderEnabled: true,
      customSmtpConfigured: false,
      schemaExposed: false,
      functionFingerprint: binding.functionFingerprint,
      permissionFingerprint: binding.permissionFingerprint,
      hookEnabled: enabled,
      hookIdentity: 'auth_mail_suppression.send_email_v1(jsonb)',
      nativeMailCheck: enabled ? 'suppressed' : 'not-run',
      networkRequests: 0,
      deliveredEmails: 0,
      planDigest: context.planDigest,
      contentDigest: context.contentDigest,
    })
    const result = await prepareAuthMailCutover(context, {
      async preflight() {
        readbacks += 1
        return evidence()
      },
      async cutover() {
        enabled = true
        return evidence()
      },
    })
    expect(result.state).toBe('cutover-applied')
    expect(readbacks).toBe(2)
  })
  it('binds the approved no-op declaration, migration and ADR to the frozen Website SHA', async () => {
    const github = sourceGitHub()
    const binding = await bindAuthMailSuppression(
      { bindingId: 'website-production', workflow: 'platform-release-auth-mail.yml' },
      { repository: 'findmydoc-platform/website', targetSha: websiteSha },
      github,
    )
    expect(binding).toMatchObject({
      bindingId: 'website-production',
      websiteSha,
      functionFingerprint: declaration.fingerprints.function,
      permissionFingerprint: declaration.fingerprints.permissions,
    })
    expect(github.reads).toHaveLength(3)
    expect(github.reads.every(({ sha }) => sha === websiteSha)).toBe(true)
    expect(canonicalJson(binding)).not.toContain('select')
  })

  it('includes suppression in the plan digest and rejects moving its Website revision', async () => {
    const github = {
      ...sourceGitHub(),
      async getLatestRelease() {
        return { sha: 'b'.repeat(40), version: 'v0.45.0' }
      },
      async getBranchSha() {
        return websiteSha
      },
      async isAncestor() {
        return true
      },
      async compareCommits() {
        return [{ bump: 'patch', message: 'fix: prepare', sha: websiteSha, url: 'https://example.test' }]
      },
      async getPullRequests() {
        return []
      },
    } as PlatformReleaseGitHubClient
    const repository = {
      branch: 'main',
      deploymentWorkflow: 'platform-release-deploy.yml',
      displayName: 'Application',
      productionUrl: 'https://example.test',
      surface: 'Application',
    }
    const plan = await createPlatformReleasePlan(
      {
        config: {
          authMail: { bindingId: 'website-production', workflow: 'platform-release-auth-mail.yml' },
          founderOps: { baseUrl: 'https://example.test', ingestPath: '/releases' },
          platformBaselineVersion: 'v0.45.0',
          repositories: {
            website: { ...repository, repository: 'findmydoc-platform/website' },
            dashboard: { ...repository, repository: 'findmydoc-platform/clinic-dashboard' },
          },
          schemaVersion: 1,
        },
      },
      github,
    )
    expect(plan.authMail?.websiteSha).toBe(websiteSha)
    plan.authMail!.websiteSha = 'c'.repeat(40)
    expect(() => validatePlatformReleasePlan(plan)).toThrow()
  })

  it.each([
    ['network statement', { [`supabase/${declaration.migration}`]: `${migration}\nselect net.http_post();` }],
    ['unapproved ADR', { 'docs/adrs/032-adr-supabase-native-mail-suppression.md': 'Draft' }],
    [
      'unexpected function',
      {
        'supabase/native-mail-suppression.json': JSON.stringify({
          ...declaration,
          function: { ...declaration.function, body: 'select deliver();' },
        }),
      },
    ],
  ])('rejects %s before any runtime operation', async (_name, files) => {
    await expect(
      bindAuthMailSuppression(
        { bindingId: 'website-production', workflow: 'platform-release-auth-mail.yml' },
        { repository: 'findmydoc-platform/website', targetSha: websiteSha },
        sourceGitHub(files),
      ),
    ).rejects.toThrow(/suppression/)
  })
})
