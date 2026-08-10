import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import type { PlatformReleaseConfig } from './types.js'

export const DEFAULT_PLATFORM_RELEASE_CONFIG_PATH = 'config/platform-release.json'

export async function loadPlatformReleaseConfig(path = DEFAULT_PLATFORM_RELEASE_CONFIG_PATH): Promise<PlatformReleaseConfig> {
  const parsed = JSON.parse(await readFile(resolve(path), 'utf8')) as PlatformReleaseConfig
  if (parsed.schemaVersion !== 1) throw new Error('Unsupported platform release configuration schema.')
  for (const key of ['dashboard', 'website'] as const) {
    const repository = parsed.repositories[key]
    if (!repository?.repository || !repository.branch || !repository.deploymentWorkflow) {
      throw new Error(`Platform release repository configuration is incomplete for ${key}.`)
    }
  }
  return parsed
}
