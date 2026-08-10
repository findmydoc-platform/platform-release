import type {
  PlatformReleaseGitHubClient,
  PlatformReleasePlan,
  PlatformRepositoryKey,
  ReleaseVisual,
} from './types.js'

const REPOSITORY_KEYS: PlatformRepositoryKey[] = ['dashboard', 'website']

function webhookUrl(raw: string, threadKey: string): URL {
  const url = new URL(raw)
  url.searchParams.set('messageReplyOption', 'REPLY_MESSAGE_FALLBACK_TO_NEW_THREAD')
  url.searchParams.set('threadKey', threadKey)
  return url
}

async function send(webhook: string, threadKey: string, body: unknown, fetchImpl: typeof fetch): Promise<void> {
  const response = await fetchImpl(webhookUrl(webhook, threadKey), {
    body: JSON.stringify(body),
    headers: { 'content-type': 'application/json' },
    method: 'POST',
  })
  if (!response.ok) throw new Error(`Google Chat release announcement failed with HTTP ${response.status}.`)
}

function visualCard(visual: ReleaseVisual): unknown {
  return {
    cardsV2: [{
      cardId: `release-visual-${visual.pullRequestNumber}`,
      card: {
        header: { title: visual.label || visual.altText || 'Release visual' },
        sections: [{ widgets: [{ image: { altText: visual.altText || visual.label, imageUrl: visual.url } }] }],
      },
    }],
  }
}

export async function announcePlatformRelease(
  input: {
    notes: string
    plan: PlatformReleasePlan
    releaseUrls: { dashboard: string; website: string }
    visuals: ReleaseVisual[]
    webhook: string
  },
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  const threadKey = `platform-release-${input.plan.version.replace(/^v/, '')}`
  await send(input.webhook, threadKey, {
    cardsV2: [{
      cardId: `platform-release-${input.plan.version}`,
      card: {
        header: { subtitle: 'Website and dashboard', title: `findmydoc ${input.plan.version}` },
        sections: [{
          widgets: [
            { textParagraph: { text: input.notes.replace(/<!--[\s\S]*?-->/g, '').trim().replace(/\n/g, '<br>') } },
            { buttonList: { buttons: [
              { text: 'Public platform release', onClick: { openLink: { url: input.releaseUrls.website } } },
              { text: 'Dashboard release', onClick: { openLink: { url: input.releaseUrls.dashboard } } },
            ] } },
          ],
        }],
      },
    }],
  }, fetchImpl)

  for (const visual of input.visuals) {
    await send(input.webhook, threadKey, visualCard(visual), fetchImpl)
  }
}

export async function announcePlatformReleaseOnce(
  input: {
    forcePending?: boolean
    notes: string
    plan: PlatformReleasePlan
    releaseUrls: { dashboard: string; website: string }
    visuals: ReleaseVisual[]
    webhook: string
  },
  github: PlatformReleaseGitHubClient,
  fetchImpl: typeof fetch = fetch,
): Promise<'already_sent' | 'sent'> {
  const details = await Promise.all(REPOSITORY_KEYS.map(async (key) => {
    const repository = input.plan.repositories[key]
    const release = await github.getRelease(repository.repository, input.plan.version)
    if (!release) throw new Error(`${repository.repository} ${input.plan.version} must exist before announcement.`)
    return { key, release, repository: repository.repository }
  }))

  if (details.some(({ release }) => release.announcementState === 'sent')) {
    await Promise.all(details
      .filter(({ release }) => release.announcementState !== 'sent')
      .map(({ repository }) => github.setReleaseAnnouncementState({
        repository,
        state: 'sent',
        version: input.plan.version,
      })))
    return 'already_sent'
  }
  if (details.some(({ release }) => release.announcementState === 'pending') && !input.forcePending) {
    throw new Error('Release announcement is pending. Inspect Google Chat, then retry announce with --force if no message was sent.')
  }

  await Promise.all(details.map(({ repository }) => github.setReleaseAnnouncementState({
    repository,
    state: 'pending',
    version: input.plan.version,
  })))
  await announcePlatformRelease(input, fetchImpl)
  await Promise.all(details.map(({ repository }) => github.setReleaseAnnouncementState({
    repository,
    state: 'sent',
    version: input.plan.version,
  })))
  return 'sent'
}
