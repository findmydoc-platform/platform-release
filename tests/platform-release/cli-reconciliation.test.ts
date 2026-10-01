import { expect, it } from 'vitest'
import { createProgram } from '../../src/cli.js'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { computePlanDigest } from '../../src/platform-release/plan.js'
import type { PlatformReleasePlan } from '../../src/platform-release/types.js'
import { loadPlatformReleaseConfig } from '../../src/platform-release/config.js'
import { computeReleaseContentDigest } from '../../src/platform-release/content.js'
import { opsBinding, opsFixture } from './supabase-fixture.js'
import type { PlatformReleaseGitHubClient, PlatformReleaseContent } from '../../src/platform-release/types.js'

it('returns a fixed JSON error and makes no app writes when the approved Ops apply has no valid audit', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'release-cli-'))
  const previousExitCode = process.exitCode
  const output: string[] = []
  try {
    const config = await loadPlatformReleaseConfig()
    const repositories = Object.fromEntries(
      Object.entries(config.repositories).map(([key, repository]) => [
        key,
        {
          ...repository,
          base:
            key === 'dashboard'
              ? { kind: 'cutover', sha: repository.cutoverSha }
              : { kind: 'release', sha: 'a'.repeat(40), version: 'v0.45.0' },
          targetSha: 'b'.repeat(40),
          commits: [],
          pullRequests:
            key === 'website'
              ? [
                  {
                    number: 1,
                    repository: repository.repository,
                    commitShas: [],
                    issues: [],
                    body: '',
                    title: 'Change',
                    url: `https://github.com/${repository.repository}/pull/1`,
                    visuals: [],
                  },
                ]
              : [],
        },
      ]),
    )
    const plan = {
      schemaVersion: 2,
      version: 'v0.46.0',
      supabaseReconciliation: opsBinding,
      repositories,
      visualCandidates: [],
      breakingChanges: [],
      highestBump: 'patch',
      manualVersion: false,
      createdAt: '2026-10-01T12:00:00Z',
    } as unknown as PlatformReleasePlan
    plan.digest = computePlanDigest(plan)
    const content: PlatformReleaseContent = {
      schemaVersion: 1,
      summary: 'Release.',
      highlights: ['change'],
      changes: [
        {
          id: 'change',
          title: 'Change',
          summary: 'Change.',
          kind: 'maintenance',
          section: 'public',
          pullRequests: [{ number: 1, repository: config.repositories.website.repository }],
          visualUrls: [],
        },
      ],
    }
    await writeFile(join(directory, 'plan.json'), JSON.stringify(plan))
    await writeFile(join(directory, 'content.json'), JSON.stringify(content))
    let appWrites = 0
    const fixture = opsFixture()
    const github = {
      ...fixture.client,
      async isAncestor() {
        return true
      },
      async getRelease() {
        return undefined
      },
      async getWorkflowArtifact() {
        throw new Error('secret must-not-leak')
      },
      async dispatchWorkflow() {
        appWrites += 1
      },
    } as unknown as PlatformReleaseGitHubClient
    await createProgram({
      createGitHubClient: () => github,
      createSupabaseRunStore: () => fixture.store,
      createFounderOpsClient: () => ({
        async ingestManifest() {
          appWrites += 1
          throw new Error('must not ingest')
        },
      }),
      writeStdout: (value) => output.push(value),
    }).parseAsync([
      'node',
      'runner',
      'apply',
      '--plan',
      join(directory, 'plan.json'),
      '--content',
      join(directory, 'content.json'),
      '--confirm-digest',
      plan.digest,
      '--confirm-content-digest',
      computeReleaseContentDigest(content),
      '--confirm-version',
      plan.version,
      '--apply',
      '--json',
    ])
    expect(JSON.parse(output.join(''))).toEqual({
      status: 'failed',
      error: { message: 'Ops preview reconciliation could not be verified; release mutations are stopped.' },
    })
    expect(appWrites).toBe(0)
    expect(fixture.runs.size).toBe(1)
  } finally {
    process.exitCode = previousExitCode
    await rm(directory, { recursive: true, force: true })
  }
})

it('requires new frozen Ops approval before credentials or live clients for legacy plans', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'release-cli-'))
  const planPath = join(directory, 'plan.json')
  const value = {
    schemaVersion: 2,
    version: 'v0.46.0',
    repositories: { website: { pullRequests: [] }, dashboard: { pullRequests: [] } },
  } as unknown as PlatformReleasePlan
  value.digest = computePlanDigest(value)
  await writeFile(planPath, JSON.stringify(value))
  const output: string[] = []
  let clientsCreated = 0
  const previousExitCode = process.exitCode
  try {
    await createProgram({
      createGitHubClient() {
        clientsCreated += 1
        throw new Error('must not create a live client')
      },
      writeStdout(value) {
        output.push(value)
      },
    }).parseAsync([
      'node',
      'runner',
      'apply',
      '--plan',
      planPath,
      '--content',
      'unavailable-content.json',
      '--confirm-digest',
      'a'.repeat(64),
      '--confirm-content-digest',
      'b'.repeat(64),
      '--confirm-version',
      'v0.46.0',
      '--apply',
      '--json',
    ])
    expect(JSON.parse(output.join(''))).toEqual({
      status: 'failed',
      error: {
        message: 'Apply requires a new approved plan with frozen Ops reconciliation scope.',
      },
    })
    expect(clientsCreated).toBe(0)
  } finally {
    await rm(directory, { recursive: true, force: true })
    process.exitCode = previousExitCode
  }
})
