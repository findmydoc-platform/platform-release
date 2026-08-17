import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import type { PlatformReleaseConfig } from './types.js'

export const DEFAULT_PLATFORM_RELEASE_CONFIG_PATH = 'config/platform-release.json'

export async function loadPlatformReleaseConfig(path = DEFAULT_PLATFORM_RELEASE_CONFIG_PATH): Promise<PlatformReleaseConfig> {
  const parsed = JSON.parse(await readFile(resolve(path), 'utf8')) as PlatformReleaseConfig
  if (parsed.schemaVersion !== 1) throw new Error('Unsupported platform release configuration schema.')
  if (!parsed.founderOps?.baseUrl || !parsed.founderOps.ingestPath) {
    throw new Error('FounderOps release ingestion configuration is incomplete.')
  }
  const founderOpsBaseUrl = new URL(parsed.founderOps.baseUrl)
  const founderOpsUrl = new URL(parsed.founderOps.ingestPath, founderOpsBaseUrl)
  if (founderOpsUrl.protocol !== 'https:' || founderOpsUrl.origin !== founderOpsBaseUrl.origin ||
    !parsed.founderOps.ingestPath.startsWith('/') || founderOpsUrl.username || founderOpsUrl.password ||
    founderOpsUrl.search || founderOpsUrl.hash) {
    throw new Error('FounderOps release ingestion must use a same-origin HTTPS path without credentials or query parameters.')
  }
  const repositoryEntries = Object.entries(parsed.repositories ?? {})
  const trustedKeys = ['dashboard', 'website']
  if (repositoryEntries.length !== trustedKeys.length || repositoryEntries.some(([key]) => !trustedKeys.includes(key))) {
    throw new Error('Platform release component catalog must contain exactly dashboard and website.')
  }
  for (const [key, repository] of repositoryEntries) {
    if (!/^[a-z][a-z0-9-]{0,63}$/.test(key) || !repository?.repository || !repository.branch ||
      !repository.deploymentWorkflow || !repository.displayName || !repository.productionUrl) {
      throw new Error(`Platform release repository configuration is incomplete for ${key}.`)
    }
    const productionUrl = new URL(repository.productionUrl)
    if (productionUrl.protocol !== 'https:' || productionUrl.username || productionUrl.password || productionUrl.search || productionUrl.hash) {
      throw new Error(`Platform release production URL is invalid for ${key}.`)
    }
  }
  for (const key of ['dashboard', 'website'] as const) {
    if (!parsed.repositories[key]) throw new Error(`Joint platform release configuration is missing ${key}.`)
  }
  return parsed
}
