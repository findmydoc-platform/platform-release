#!/usr/bin/env node
import { Command } from 'commander'
import { pathToFileURL } from 'node:url'
import { announcePlatformReleaseOnce } from './platform-release/announce.js'
import { applyPlatformRelease, readApprovedReleaseNotes } from './platform-release/apply.js'
import { DEFAULT_PLATFORM_RELEASE_CONFIG_PATH, loadPlatformReleaseConfig } from './platform-release/config.js'
import { GhPlatformReleaseClient } from './platform-release/github.js'
import { approvedReleaseVisuals, releaseNotesTemplate } from './platform-release/notes.js'
import {
  createPlatformReleasePlan,
  readPlatformReleasePlan,
  writePlatformReleasePlan,
} from './platform-release/plan.js'
import { getPlatformReleaseStatus } from './platform-release/status.js'
import type { PlatformReleaseGitHubClient } from './platform-release/types.js'

type PlanOptions = {
  configPath: string
  json?: boolean
  notesTemplate?: string
  output?: string
  version?: string
}

type ApplyOptions = {
  announce?: boolean
  apply: boolean
  configPath: string
  confirmDigest: string
  confirmVersion: string
  json?: boolean
  notes: string
  plan: string
}

type StatusOptions = {
  json?: boolean
  plan: string
}

type AnnounceOptions = {
  confirmDigest: string
  confirmVersion: string
  force?: boolean
  json?: boolean
  notes: string
  plan: string
  send: boolean
}

type CliRuntime = {
  createGitHubClient: () => PlatformReleaseGitHubClient
  writeStderr: (value: string) => void
  writeStdout: (value: string) => void
}

const defaultRuntime: CliRuntime = {
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

export function createProgram(runtimeOverrides: Partial<CliRuntime> = {}): Command {
  const runtime = { ...defaultRuntime, ...runtimeOverrides }
  const program = new Command()
  program.name('fmd-platform-release').description('Publish one findmydoc version across both applications').version('0.1.0')
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
    .option('--notes-template <path>', 'write a release-notes drafting template')
    .option('--json', 'emit JSON output')
    .action(async (options: PlanOptions) => {
      try {
        const config = await loadPlatformReleaseConfig(options.configPath)
        const plan = await createPlatformReleasePlan(
          { config, manualVersion: options.version },
          runtime.createGitHubClient(),
        )
        if (options.output) await writePlatformReleasePlan(options.output, plan)
        if (options.notesTemplate) {
          const { mkdir, writeFile } = await import('node:fs/promises')
          const { dirname, resolve } = await import('node:path')
          const notesPath = resolve(options.notesTemplate)
          await mkdir(dirname(notesPath), { recursive: true })
          await writeFile(notesPath, releaseNotesTemplate(plan), 'utf8')
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
    .command('apply')
    .description('Deploy both frozen SHAs and publish both GitHub releases')
    .requiredOption('--plan <path>', 'immutable JSON plan created by plan')
    .requiredOption('--notes <path>', 'approved release notes Markdown')
    .requiredOption('--confirm-digest <digest>', 'must exactly match the frozen plan digest')
    .requiredOption('--confirm-version <version>', 'must exactly match the planned version')
    .requiredOption('--apply', 'perform deployments and publication')
    .option('--config-path <path>', 'trusted platform release configuration path', DEFAULT_PLATFORM_RELEASE_CONFIG_PATH)
    .option('--announce', 'send the joint Google Chat announcement after publication')
    .option('--json', 'emit JSON output')
    .action(async (options: ApplyOptions) => {
      try {
        if (!options.apply) throw new Error('--apply is required for platform release publication.')
        const [config, plan, notes] = await Promise.all([
          loadPlatformReleaseConfig(options.configPath),
          readPlatformReleasePlan(options.plan),
          readApprovedReleaseNotes(options.notes),
        ])
        const result = await applyPlatformRelease({
          announce: options.announce === true,
          config,
          confirmDigest: options.confirmDigest,
          confirmVersion: options.confirmVersion,
          notes,
          plan,
          webhook: process.env.GOOGLE_CHAT_WEBHOOK_URL,
        }, runtime.createGitHubClient())
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
        const result = await getPlatformReleaseStatus(
          await readPlatformReleasePlan(options.plan),
          runtime.createGitHubClient(),
        )
        writeJson(result, runtime.writeStdout)
      } catch (error) {
        writeError(error, options.json, runtime)
      }
    })

  program
    .command('announce')
    .description('Send the joint announcement for already published application releases')
    .requiredOption('--plan <path>', 'immutable JSON plan')
    .requiredOption('--notes <path>', 'approved release notes Markdown')
    .requiredOption('--confirm-digest <digest>', 'must exactly match the frozen plan digest')
    .requiredOption('--confirm-version <version>', 'must exactly match the planned version')
    .requiredOption('--send', 'send the announcement')
    .option('--force', 'continue an ambiguous pending announcement after checking Google Chat')
    .option('--json', 'emit JSON output')
    .action(async (options: AnnounceOptions) => {
      try {
        const [plan, notes] = await Promise.all([
          readPlatformReleasePlan(options.plan),
          readApprovedReleaseNotes(options.notes),
        ])
        if (options.confirmDigest !== plan.digest) throw new Error(`Digest confirmation must exactly match ${plan.digest}.`)
        if (options.confirmVersion !== plan.version) throw new Error(`Confirmation must exactly match ${plan.version}.`)
        if (!options.send) throw new Error('--send is required for the release announcement.')
        const webhook = process.env.GOOGLE_CHAT_WEBHOOK_URL
        if (!webhook) throw new Error('GOOGLE_CHAT_WEBHOOK_URL is required for the release announcement.')
        const github = runtime.createGitHubClient()
        const [website, dashboard] = await Promise.all([
          github.getRelease(plan.repositories.website.repository, plan.version),
          github.getRelease(plan.repositories.dashboard.repository, plan.version),
        ])
        if (!website || !dashboard) throw new Error('Both application releases must exist before announcement.')
        const status = await announcePlatformReleaseOnce({
          forcePending: options.force === true,
          notes,
          plan,
          releaseUrls: { dashboard: dashboard.url, website: website.url },
          visuals: approvedReleaseVisuals(plan, notes),
          webhook,
        }, github)
        writeJson({ status, version: plan.version }, runtime.writeStdout)
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
