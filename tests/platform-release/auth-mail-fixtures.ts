import { canonicalJson, sha256 } from '../../src/platform-release/canonical.js'
import type { AuthMailContext, AuthMailProgress, AuthMailStateStore } from '../../src/platform-release/auth-mail.js'
import type { AuthMailSuppressionBinding } from '../../src/platform-release/types.js'

export const suppressionBinding: AuthMailSuppressionBinding = {
  bindingId: 'website-production',
  workflow: 'platform-release-auth-mail.yml',
  websiteSha: 'a'.repeat(40),
  adrDigest: '1'.repeat(64),
  declarationDigest: '2'.repeat(64),
  migrationDigest: '3'.repeat(64),
  functionFingerprint: '4576724f01312619005205245a81bcb1756c257a6777b5c6399a8b807eeeb7af',
  permissionFingerprint: '87bf0181149020c959b00de652c2506e11a682dcae5a0d6fa8bb06bcd5b14cfd',
}

export function suppressionEvidence(context: AuthMailContext, hookEnabled = true) {
  return {
    bindingDigest: sha256(canonicalJson(context.binding)),
    environment: 'production',
    permissionVerified: true,
    emailProviderEnabled: true,
    customSmtpConfigured: false,
    schemaExposed: false,
    functionFingerprint: suppressionBinding.functionFingerprint,
    permissionFingerprint: suppressionBinding.permissionFingerprint,
    hookEnabled,
    hookIdentity: 'auth_mail_suppression.send_email_v1(jsonb)',
    nativeMailCheck: hookEnabled ? 'suppressed' : 'not-run',
    networkRequests: 0,
    deliveredEmails: 0,
    planDigest: context.planDigest,
    contentDigest: context.contentDigest,
  }
}

export class MemoryAuthMailState implements AuthMailStateStore {
  progress?: AuthMailProgress
  async getState() {
    return this.progress
  }
  async setState(_context: AuthMailContext, progress: AuthMailProgress) {
    if (this.progress?.rollback && !progress.rollback) throw new Error('Explicit rollback cannot be cleared')
    this.progress = progress
  }
}
