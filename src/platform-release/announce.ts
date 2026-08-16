import type {
  PlatformReleaseAnnouncementStore,
  PlatformReleaseGitHubClient,
  PlatformReleaseManifestV2,
} from './types.js'

function webhookUrl(raw: string, threadKey: string): URL {
  const url = new URL(raw)
  url.searchParams.set('messageReplyOption', 'REPLY_MESSAGE_FALLBACK_TO_NEW_THREAD')
  url.searchParams.set('threadKey', threadKey)
  return url
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
}

export async function announcePlatformRelease(
  input: {
    founderOpsUrl: string
    manifest: PlatformReleaseManifestV2
    webhook: string
  },
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  const response = await fetchImpl(webhookUrl(input.webhook, `platform-release-${input.manifest.version.replace(/^v/, '')}`), {
    body: JSON.stringify({
      cardsV2: [{
        cardId: `platform-release-${input.manifest.version}`,
        card: {
          header: { title: `findmydoc ${input.manifest.version}` },
          sections: [{
            widgets: [
              { textParagraph: { text: `${escapeHtml(input.manifest.summary)}<br><br><b>Enthalten:</b> Website · Clinic Dashboard` } },
              { buttonList: { buttons: [{
                onClick: { openLink: { url: input.founderOpsUrl } },
                text: 'Release in FounderOps öffnen',
              }] } },
            ],
          }],
        },
      }],
    }),
    headers: { 'content-type': 'application/json' },
    method: 'POST',
  })
  if (!response.ok) throw new Error(`Google Chat release announcement failed with HTTP ${response.status}.`)
}

export async function assertPublishedPlatformRelease(
  manifest: PlatformReleaseManifestV2,
  github: PlatformReleaseGitHubClient,
): Promise<void> {
  await Promise.all(manifest.components.map(async (component) => {
    const release = await github.getRelease(component.repository, manifest.version)
    if (!release) throw new Error(`${component.repository} ${manifest.version} must exist before announcement.`)
    if (release.draft || !release.publishedAt || !release.manifestAttached ||
      release.sha !== component.targetSha || release.url !== component.release) {
      throw new Error(`${component.repository} release does not match the approved platform manifest.`)
    }
  }))
}

export async function announcePlatformReleaseOnce(
  input: {
    forcePending?: boolean
    founderOpsUrl: string
    manifest: PlatformReleaseManifestV2
    webhook: string
  },
  github: PlatformReleaseGitHubClient,
  announcementStore: PlatformReleaseAnnouncementStore,
  fetchImpl: typeof fetch = fetch,
): Promise<'already_sent' | 'sent'> {
  await assertPublishedPlatformRelease(input.manifest, github)

  const state = await announcementStore.getState(input.manifest.manifestDigest)
  if (state === 'sent') return 'already_sent'
  if (state === 'pending' && !input.forcePending) {
    throw new Error('Release announcement is pending. Inspect Google Chat, then retry announce with --force if no message was sent.')
  }

  await announcementStore.setState({
    manifestDigest: input.manifest.manifestDigest,
    state: 'pending',
    version: input.manifest.version,
  })
  await announcePlatformRelease(input, fetchImpl)
  await announcementStore.setState({
    founderOpsUrl: input.founderOpsUrl,
    manifestDigest: input.manifest.manifestDigest,
    state: 'sent',
    version: input.manifest.version,
  })
  return 'sent'
}
