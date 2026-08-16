#!/usr/bin/env node
import { Command } from 'commander'
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { announcePlatformReleaseOnce, assertPublishedPlatformRelease } from './platform-release/announce.js'
import { applyPlatformRelease } from './platform-release/apply.js'
import {
  computeReleaseContentDigest,
  readReleaseContent,
  releaseContentTemplate,
  renderReleaseContentPreview,
} from './platform-release/content.js'
import { DEFAULT_PLATFORM_RELEASE_CONFIG_PATH, loadPlatformReleaseConfig } from './platform-release/config.js'
import { HttpFounderOpsReleaseClient } from './platform-release/founder-ops.js'
import { GhPlatformReleaseAnnouncementStore, GhPlatformReleaseClient } from './platform-release/github.js'
import { readPlatformReleaseManifest, validateManifestAgainstConfig } from './platform-release/manifest.js'
import {
  createPlatformReleasePlan,
  readPlatformReleasePlan,
  writePlatformReleasePlan,
} from './platform-release/plan.js'
import {
  inspectImmutableManifestGapRecovery,
  recoverImmutableManifestGap,
} from './platform-release/recover.js'
import { getPlatformReleaseStatus } from './platform-release/status.js'
import type { PlatformReleaseAnnouncementStore, PlatformReleaseGitHubClient } from './platform-release/types.js'

type PlanOptions = { configPath: string; contentTemplate?: string; json?: boolean; output?: string; version?: string }
type ContentOptions = { content: string; json?: boolean; plan: string }
type ApplyOptions = {
  announce?: boolean
  apply: boolean
  configPath: string
  confirmContentDigest: string
  confirmDigest: string
  confirmVersion: string
  content: string
  json?: boolean
  manifestOutput: string
  plan: string
}
type StatusOptions = { json?: boolean; plan: string }
type AnnounceOptions = { configPath: string; confirmManifestDigest: string; force?: boolean; json?: boolean; manifest: string; send: boolean }
type RecoverOptions = {
  announce?: boolean
  apply?: boolean
  configPath: string
  confirmContentDigest: string
  confirmDigest: string
  confirmManifestDigest: string
  confirmMissingManifestRepository: string
  confirmMissingPlatformPublishedAt: boolean
  confirmMutableManifestRepository: string
  confirmVersion: string
  content: string
  force?: boolean
  json?: boolean
  manifest: string
  plan: string
}
type CliRuntime = {
  createAnnouncementStore: () => PlatformReleaseAnnouncementStore
  createGitHubClient: () => PlatformReleaseGitHubClient
  writeStderr: (value: string) => void
  writeStdout: (value: string) => void
}

const defaultRuntime: CliRuntime = {
  createAnnouncementStore: () => new GhPlatformReleaseAnnouncementStore(
    process.env.GITHUB_REPOSITORY ?? 'findmydoc-platform/platform-release',
    process.env.GITHUB_SHA ?? 'main',
    process.env.GITHUB_STATE_TOKEN ?? '',
  ),
  createGitHubClient: () => new GhPlatformReleaseClient(),
  writeStderr: (value) => process.stderr.write(value),
  writeStdout: (value) => process.stdout.write(value),
}

function writeJson(value: unknown, write: (value: string) => void): void {
  write(`${JSON.stringify(value, null, 2)}\n`)
}

function writeError(error: unknown, json: boolean | undefined, runtime: CliRuntime): void {
  const message = error instanceof Error ? error.message : String(error)
  if (json) writeJson({ error: { message }, status: 'failed' }, runtime.writeStdout)
  else runtime.writeStderr(`${message}\n`)
  process.exitCode = 1
}

function isCommanderError(error: unknown): error is Error & { code: string; exitCode: number } {
  if (!error || typeof error !== 'object') return false
  const candidate = error as { code?: unknown; exitCode?: unknown }
  return typeof candidate.code === 'string' && typeof candidate.exitCode === 'number'
}

function founderOpsClient(config: Awaited<ReturnType<typeof loadPlatformReleaseConfig>>): HttpFounderOpsReleaseClient {
  return new HttpFounderOpsReleaseClient(
    config.founderOps.baseUrl,
    config.founderOps.ingestPath,
    process.env.FOUNDEROPS_PLATFORM_RELEASE_TOKEN ?? '',
  )
}

export function createProgram(runtimeOverrides: Partial<CliRuntime> = {}): Command {
  const runtime = { ...defaultRuntime, ...runtimeOverrides }
  const program = new Command()
  program.name('fmd-platform-release').description('Publish one findmydoc version across both applications').version('0.2.0')
  program.configureOutput({
    outputError: (value, write) => write(value),
    writeErr: runtime.writeStderr,
    writeOut: runtime.writeStdout,
  })
  program.exitOverride()

  program
    .command('plan')
    .description('Create a read-only, SHA-frozen platform release plan')
    .option('--config-path <path>', 'platform release configuration path', DEFAULT_PLATFORM_RELEASE_CONFIG_PATH)
    .option('--version <version>', 'explicit platform version for a manually decided release')
    .option('--output <path>', 'write the immutable JSON plan to this path')
    .option('--content-template <path>', 'write a structured release-content drafting template')
    .option('--json', 'emit JSON output')
    .action(async (options: PlanOptions) => {
      try {
        const config = await loadPlatformReleaseConfig(options.configPath)
        const plan = await createPlatformReleasePlan({ config, manualVersion: options.version }, runtime.createGitHubClient())
        if (options.output) await writePlatformReleasePlan(options.output, plan)
        if (options.contentTemplate) {
          const contentPath = resolve(options.contentTemplate)
          await mkdir(dirname(contentPath), { recursive: true })
          await writeFile(contentPath, `${JSON.stringify(releaseContentTemplate(plan), null, 2)}\n`, 'utf8')
        }
        if (options.json) writeJson(plan, runtime.writeStdout)
        else runtime.writeStdout([
          `findmydoc ${plan.version}`,
          `Plan digest: ${plan.digest}`,
          `Website: ${plan.repositories.website.targetSha}`,
          `Dashboard: ${plan.repositories.dashboard.targetSha}`,
          `Version bump: ${plan.highestBump}${plan.manualVersion ? ' (manual version)' : ''}`,
        ].join('\n') + '\n')
      } catch (error) {
        writeError(error, options.json, runtime)
      }
    })

  program
    .command('content')
    .description('Validate structured release content and render its German reading view')
    .requiredOption('--plan <path>', 'immutable JSON plan')
    .requiredOption('--content <path>', 'approved structured release content JSON')
    .option('--json', 'emit JSON output')
    .action(async (options: ContentOptions) => {
      try {
        const plan = await readPlatformReleasePlan(options.plan)
        const content = await readReleaseContent(options.content, plan)
        const result = {
          content,
          contentDigest: computeReleaseContentDigest(content),
          planDigest: plan.digest,
          preview: renderReleaseContentPreview(content),
          version: plan.version,
        }
        if (options.json) writeJson(result, runtime.writeStdout)
        else runtime.writeStdout(`${result.preview}\n\nVersion: ${result.version}\nPlan digest: ${result.planDigest}\nContent digest: ${result.contentDigest}\n`)
      } catch (error) {
        writeError(error, options.json, runtime)
      }
    })

  program
    .command('apply')
    .description('Deploy both frozen SHAs and publish the joint platform release')
    .requiredOption('--plan <path>', 'immutable JSON plan created by plan')
    .requiredOption('--content <path>', 'approved structured release content JSON')
    .requiredOption('--confirm-digest <digest>', 'must exactly match the frozen plan digest')
    .requiredOption('--confirm-content-digest <digest>', 'must exactly match the approved content digest')
    .requiredOption('--confirm-version <version>', 'must exactly match the planned version')
    .requiredOption('--apply', 'perform deployments and publication')
    .option('--manifest-output <path>', 'write the canonical manifest for resume', 'artifacts/platform-release/platform-release.json')
    .option('--config-path <path>', 'trusted platform release configuration path', DEFAULT_PLATFORM_RELEASE_CONFIG_PATH)
    .option('--announce', 'send the compact Google Chat announcement after FounderOps ingestion')
    .option('--json', 'emit JSON output')
    .action(async (options: ApplyOptions) => {
      try {
        if (!options.apply) throw new Error('--apply is required for platform release publication.')
        const [config, plan] = await Promise.all([
          loadPlatformReleaseConfig(options.configPath),
          readPlatformReleasePlan(options.plan),
        ])
        const content = await readReleaseContent(options.content, plan)
        const result = await applyPlatformRelease({
          announce: options.announce === true,
          config,
          confirmContentDigest: options.confirmContentDigest,
          confirmDigest: options.confirmDigest,
          confirmVersion: options.confirmVersion,
          content,
          onManifest: async (manifest) => {
            const manifestPath = resolve(options.manifestOutput)
            await mkdir(dirname(manifestPath), { recursive: true })
            await writeFile(manifestPath, manifest, 'utf8')
          },
          plan,
          webhook: process.env.GOOGLE_CHAT_WEBHOOK_URL,
        }, runtime.createGitHubClient(), founderOpsClient(config), runtime.createAnnouncementStore())
        if (options.json) writeJson(result, runtime.writeStdout)
        else runtime.writeStdout(`Published findmydoc ${result.version}.\n`)
      } catch (error) {
        writeError(error, options.json, runtime)
      }
    })

  program
    .command('status')
    .description('Inspect deployments and GitHub releases for a frozen plan')
    .requiredOption('--plan <path>', 'immutable JSON plan')
    .option('--json', 'emit JSON output')
    .action(async (options: StatusOptions) => {
      try {
        writeJson(await getPlatformReleaseStatus(await readPlatformReleasePlan(options.plan), runtime.createGitHubClient()), runtime.writeStdout)
      } catch (error) {
        writeError(error, options.json, runtime)
      }
    })

  program
    .command('announce')
    .description('Ingest an existing manifest idempotently, then send its compact Google Chat announcement')
    .requiredOption('--manifest <path>', 'canonical platform-release.json manifest')
    .requiredOption('--confirm-manifest-digest <digest>', 'must exactly match the manifest digest')
    .requiredOption('--send', 'send the announcement')
    .option('--config-path <path>', 'trusted platform release configuration path', DEFAULT_PLATFORM_RELEASE_CONFIG_PATH)
    .option('--force', 'continue an ambiguous pending announcement after checking Google Chat')
    .option('--json', 'emit JSON output')
    .action(async (options: AnnounceOptions) => {
      try {
        if (!options.send) throw new Error('--send is required for the release announcement.')
        const webhook = process.env.GOOGLE_CHAT_WEBHOOK_URL
        if (!webhook) throw new Error('GOOGLE_CHAT_WEBHOOK_URL is required for the release announcement.')
        const [config, manifestFile] = await Promise.all([
          loadPlatformReleaseConfig(options.configPath),
          readPlatformReleaseManifest(options.manifest),
        ])
        if (options.confirmManifestDigest !== manifestFile.manifest.manifestDigest) {
          throw new Error(`Manifest digest confirmation must exactly match ${manifestFile.manifest.manifestDigest}.`)
        }
        validateManifestAgainstConfig(manifestFile.manifest, config)
        const github = runtime.createGitHubClient()
        await assertPublishedPlatformRelease(manifestFile.manifest, github)
        for (const component of manifestFile.manifest.components) {
          await github.ensureReleaseManifest({
            manifest: manifestFile.serialized,
            repository: component.repository,
            version: manifestFile.manifest.version,
          })
        }
        const ingested = await founderOpsClient(config).ingestManifest({
          manifest: manifestFile.serialized,
          manifestDigest: manifestFile.manifest.manifestDigest,
        })
        const status = await announcePlatformReleaseOnce({
          forcePending: options.force === true,
          founderOpsUrl: ingested.url,
          manifest: manifestFile.manifest,
          webhook,
        }, github, runtime.createAnnouncementStore())
        writeJson({ founderOps: ingested, status, version: manifestFile.manifest.version }, runtime.writeStdout)
      } catch (error) {
        writeError(error, options.json, runtime)
      }
    })

  program
    .command('recover')
    .description('Recover FounderOps ingestion and announcement from one verified immutable manifest-asset gap')
    .requiredOption('--plan <path>', 'original immutable JSON plan')
    .requiredOption('--content <path>', 'original approved structured release content JSON')
    .requiredOption('--manifest <path>', 'canonical platform-release.json from the complete release')
    .requiredOption('--confirm-version <version>', 'must exactly match the original release version')
    .requiredOption('--confirm-digest <digest>', 'must exactly match the original frozen plan digest')
    .requiredOption('--confirm-content-digest <digest>', 'must exactly match the original approved content digest')
    .requiredOption('--confirm-manifest-digest <digest>', 'must exactly match the canonical manifest digest')
    .requiredOption('--confirm-missing-manifest-repository <repository>', 'must name the single immutable release missing the manifest asset')
    .requiredOption('--confirm-mutable-manifest-repository <repository>', 'must name the other manifest-bearing release that remains mutable')
    .requiredOption('--confirm-missing-platform-published-at', 'explicitly accept that both legacy releases lack stable publication metadata')
    .option('--config-path <path>', 'trusted platform release configuration path', DEFAULT_PLATFORM_RELEASE_CONFIG_PATH)
    .option('--apply', 'perform FounderOps ingestion and optional announcement after the read-only checks')
    .option('--announce', 'send the compact Google Chat announcement after FounderOps ingestion')
    .option('--force', 'continue an ambiguous pending announcement after checking Google Chat')
    .option('--json', 'emit JSON output')
    .action(async (options: RecoverOptions) => {
      try {
        const [config, plan, manifestFile] = await Promise.all([
          loadPlatformReleaseConfig(options.configPath),
          readPlatformReleasePlan(options.plan),
          readPlatformReleaseManifest(options.manifest),
        ])
        const content = await readReleaseContent(options.content, plan)
        const input = {
          announce: options.announce === true,
          config,
          confirmContentDigest: options.confirmContentDigest,
          confirmDigest: options.confirmDigest,
          confirmManifestDigest: options.confirmManifestDigest,
          confirmMissingManifestRepository: options.confirmMissingManifestRepository,
          confirmMissingPlatformPublishedAt: options.confirmMissingPlatformPublishedAt,
          confirmMutableManifestRepository: options.confirmMutableManifestRepository,
          confirmVersion: options.confirmVersion,
          content,
          forceAnnouncement: options.force === true,
          manifest: manifestFile.manifest,
          plan,
          serializedManifest: manifestFile.serialized,
          webhook: process.env.GOOGLE_CHAT_WEBHOOK_URL,
        }
        const github = runtime.createGitHubClient()
        const result = options.apply
          ? await recoverImmutableManifestGap(
            input,
            github,
            founderOpsClient(config),
            runtime.createAnnouncementStore(),
          )
          : await inspectImmutableManifestGapRecovery(input, github)
        writeJson(result, runtime.writeStdout)
      } catch (error) {
        writeError(error, options.json, runtime)
      }
    })

  return program
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const wantsJson = process.argv.includes('--json')
  const runtime = wantsJson ? { ...defaultRuntime, writeStderr: () => undefined } : defaultRuntime
  try {
    await createProgram(runtime).parseAsync(process.argv)
  } catch (error) {
    if (isCommanderError(error) && error.code === 'commander.helpDisplayed') process.exitCode = 0
    else if (isCommanderError(error) && !wantsJson) process.exitCode = error.exitCode
    else writeError(error, wantsJson, defaultRuntime)
  }
}
