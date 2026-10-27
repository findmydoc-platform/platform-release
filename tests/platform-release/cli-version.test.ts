import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { createProgram } from '../../src/cli.js'
import { loadPlatformReleaseConfig } from '../../src/platform-release/config.js'
import type { PlatformReleaseGitHubClient } from '../../src/platform-release/types.js'

it.each([
  ['--version', 'v0.51.2'],
  ['--version=v0.51.2'],
])('creates the manually selected release plan with %j', async (...versionArguments) => {
  const directory = await mkdtemp(join(tmpdir(), 'release-cli-version-'))
  const previousExitCode = process.exitCode
  const output: string[] = []
  try {
    const config = await loadPlatformReleaseConfig()
    delete config.supabaseReconciliation
    const configPath = join(directory, 'config.json')
    await writeFile(configPath, JSON.stringify(config))
    const github = {
      async getLatestRelease() {
        return { sha: 'a'.repeat(40), version: 'v0.51.0' }
      },
      async getBranchSha() {
        return 'b'.repeat(40)
      },
      async isAncestor() {
        return true
      },
      async compareCommits() {
        return [{ bump: 'patch', message: 'fix: test change', sha: 'c'.repeat(40), url: 'https://example.test/commit' }]
      },
      async getPullRequests() {
        return []
      },
    } as unknown as PlatformReleaseGitHubClient

    await createProgram({
      createGitHubClient: () => github,
      writeStdout: (value) => output.push(value),
    }).parseAsync(['node', 'runner', 'plan', '--config-path', configPath, ...versionArguments, '--json'])

    expect(JSON.parse(output.join(''))).toMatchObject({
      version: 'v0.51.2',
      manualVersion: true,
      highestBump: 'patch',
    })
    expect(process.exitCode).toBe(previousExitCode)
  } finally {
    process.exitCode = previousExitCode
    await rm(directory, { recursive: true, force: true })
  }
})

it('keeps the top-level tool version available without creating a live client', async () => {
  const output: string[] = []
  let clientsCreated = 0
  const program = createProgram({
    createGitHubClient() {
      clientsCreated += 1
      throw new Error('must not create a live client')
    },
    writeStdout: (value) => output.push(value),
  })

  await expect(program.parseAsync(['node', 'runner', '--version'])).rejects.toMatchObject({
    code: 'commander.version',
    exitCode: 0,
  })
  expect(output.join('')).toBe('0.3.0\n')
  expect(clientsCreated).toBe(0)
})

