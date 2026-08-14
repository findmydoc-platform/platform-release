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
  for (const key of ['dashboard', 'website'] as const) {
    const repository = parsed.repositories[key]
    if (!repository?.repository || !repository.branch || !repository.deploymentWorkflow || !repository.displayName) {
      throw new Error(`Platform release repository configuration is incomplete for ${key}.`)
    }
  }
  return parsed
}
