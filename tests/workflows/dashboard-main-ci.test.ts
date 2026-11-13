import { spawnSync } from 'node:child_process'
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { parse } from 'yaml'

const repository = 'findmydoc-platform/clinic-dashboard'
const targetSha = 'a'.repeat(40)
const basePath = `repos/${repository}/actions`
const workflow = { id: 312598734, name: 'CI', path: '.github/workflows/ci.yml', state: 'active' }
const run = {
  id: 101,
  workflow_id: workflow.id,
  path: workflow.path,
  event: 'push',
  head_branch: 'main',
  head_sha: targetSha,
  repository: { full_name: repository },
  head_repository: { full_name: repository },
  run_attempt: 2,
  status: 'completed',
  conclusion: 'success',
}

type Response = { endpoint: string; body?: unknown; error?: boolean; raw?: string }
const responsesFor = (candidate = run): Response[] => [
  { endpoint: `${basePath}/workflows/ci.yml`, body: workflow },
  {
    endpoint: `${basePath}/workflows/${workflow.id}/runs?event=push&branch=main&head_sha=${targetSha}&per_page=100`,
    body: { total_count: 1, workflow_runs: [candidate] },
  },
  { endpoint: `${basePath}/runs/101`, body: candidate },
  { endpoint: `${basePath}/runs/101/attempts/${candidate.run_attempt}`, body: candidate },
  { endpoint: `${basePath}/runs/101`, body: candidate },
]
const directories = new Set<string>()

function createGate() {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'dashboard-main-ci-'))
  directories.add(directory)
  const yaml = parse(
    readFileSync(new URL('../../.github/workflows/reusable-deploy-dashboard.yml', import.meta.url), 'utf8'),
  )
  const prepare = yaml.jobs.deploy.steps.find((step: { name?: string }) => step.name === 'Prepare main CI gate')
  expect(prepare, 'The pinned platform workflow must provide the CI gate.').toBeDefined()
  const environment = {
    ...process.env,
    PATH: `${directory}:${process.env.PATH}`,
    RUNNER_TEMP: directory,
    GITHUB_REPOSITORY: repository,
    TARGET_SHA: targetSha,
    GH_TOKEN: 'synthetic-test-token',
    CI_STUB_RESPONSES: path.join(directory, 'responses.json'),
    CI_STUB_REQUESTS: path.join(directory, 'requests.json'),
  }
  const prepared = spawnSync('bash', ['-c', prepare.run], { env: environment, encoding: 'utf8' })
  expect(prepared.status, prepared.stderr).toBe(0)
  const stub = path.join(directory, 'gh')
  writeFileSync(
    stub,
    `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
const requests = JSON.parse(fs.readFileSync(process.env.CI_STUB_REQUESTS, 'utf8'));
requests.push(args);
fs.writeFileSync(process.env.CI_STUB_REQUESTS, JSON.stringify(requests));
const responses = JSON.parse(fs.readFileSync(process.env.CI_STUB_RESPONSES, 'utf8'));
const response = responses.shift();
fs.writeFileSync(process.env.CI_STUB_RESPONSES, JSON.stringify(responses));
if (!response || JSON.stringify(args) !== JSON.stringify(['api', '--hostname', 'github.com', '--method', 'GET', response.endpoint])) {
  console.error('Unexpected GitHub request: ' + JSON.stringify(args));
  process.exit(2);
}
if (response.error) process.exit(1);
process.stdout.write(response.raw === undefined ? JSON.stringify(response.body) : response.raw);
`,
  )
  chmodSync(stub, 0o700)
  return {
    execute(responses: Response[], phase = 'initial', overrides: Record<string, string> = {}) {
      writeFileSync(environment.CI_STUB_RESPONSES, JSON.stringify(responses))
      writeFileSync(environment.CI_STUB_REQUESTS, '[]')
      return spawnSync('bash', [path.join(directory, 'dashboard-main-ci-gate.sh'), phase], {
        env: { ...environment, ...overrides },
        encoding: 'utf8',
        timeout: 5000,
      })
    },
  }
}

afterEach(() => {
  for (const directory of directories) rmSync(directory, { recursive: true, force: true })
  directories.clear()
})

describe('dashboard main CI evidence gate', () => {
  it('accepts a successful current push attempt for the exact frozen SHA and rechecks before deployment', () => {
    const gate = createGate()
    const initial = gate.execute(responsesFor())
    expect(initial.status, initial.stderr).toBe(0)
    const final = gate.execute(responsesFor(), 'final')
    expect(final.status, final.stderr).toBe(0)
  })

  it.each([
    ['repository', { repository: { full_name: 'other/dashboard' } }],
    ['head repository', { head_repository: { full_name: 'other/dashboard' } }],
    ['workflow ID', { workflow_id: 999 }],
    ['workflow path', { path: '.github/workflows/other.yml' }],
    ['event', { event: 'pull_request' }],
    ['manual event', { event: 'workflow_dispatch' }],
    ['branch', { head_branch: 'feature/example' }],
    ['SHA', { head_sha: 'b'.repeat(40) }],
    ['run ID', { id: null }],
    ['attempt', { run_attempt: 0 }],
    ['missing status', { status: undefined }],
    ['missing conclusion', { conclusion: undefined }],
  ])('rejects mismatched or incomplete %s evidence', (_name, overrides) => {
    const responses = responsesFor()
    responses[1]!.body = { total_count: 1, workflow_runs: [{ ...run, ...overrides }] }
    expect(createGate().execute(responses).status).not.toBe(0)
  })

  it.each(['queued', 'in_progress', 'waiting', 'pending', 'requested'])('rejects a %s current attempt', (status) => {
    expect(createGate().execute(responsesFor({ ...run, status, conclusion: '' })).status).not.toBe(0)
  })

  it.each(['failure', 'cancelled', 'timed_out', 'action_required', 'neutral', 'skipped', 'stale', 'startup_failure'])(
    'rejects a completed %s attempt',
    (conclusion) => {
      expect(createGate().execute(responsesFor({ ...run, conclusion })).status).not.toBe(0)
    },
  )

  it.each([
    ['missing run', { total_count: 0, workflow_runs: [] }],
    [
      'multiple runs, including an older success',
      { total_count: 2, workflow_runs: [run, { ...run, id: 102, conclusion: 'failure' }] },
    ],
    ['truncated ambiguous results', { total_count: 101, workflow_runs: [run] }],
    ['missing count', { workflow_runs: [run] }],
    ['contradictory count', { total_count: 1, workflow_runs: [] }],
  ])('rejects %s', (_name, body) => {
    const responses = responsesFor()
    responses[1]!.body = body
    expect(createGate().execute(responses).status).not.toBe(0)
  })

  it.each([
    { name: 'Other CI' },
    { path: '.github/workflows/other.yml' },
    { state: 'disabled_manually' },
    { id: undefined },
  ])('rejects an unexpected workflow identity %j', (overrides) => {
    const responses = responsesFor()
    responses[0]!.body = { ...workflow, ...overrides }
    expect(createGate().execute(responses).status).not.toBe(0)
  })

  it.each(['in_progress', 'failure', 'cancelled', 'success'])(
    'rejects stale green list evidence when the live run has a newer %s attempt',
    (state) => {
      const responses = responsesFor()
      responses[2]!.body = {
        ...run,
        run_attempt: 3,
        status: state === 'in_progress' ? 'in_progress' : 'completed',
        conclusion: state === 'in_progress' ? null : state,
      }
      expect(createGate().execute(responses).status).not.toBe(0)
    },
  )

  it('rejects an attempt endpoint that does not match the current successful run', () => {
    const responses = responsesFor()
    responses[3]!.body = { ...run, run_attempt: 1 }
    expect(createGate().execute(responses).status).not.toBe(0)
  })

  it('rejects a rerun started after reading a historical successful attempt', () => {
    const responses = responsesFor()
    responses[4]!.body = { ...run, run_attempt: 3, status: 'in_progress', conclusion: null }
    expect(createGate().execute(responses).status).not.toBe(0)
  })

  it.each([2, 3, 4])('rejects an identity mismatch in API response %s', (index) => {
    const responses = responsesFor()
    responses[index]!.body = { ...run, head_sha: 'b'.repeat(40) }
    expect(createGate().execute(responses).status).not.toBe(0)
  })

  it.each([0, 1, 2, 3, 4])('fails closed on GitHub API error at response %s', (index) => {
    const responses = responsesFor()
    responses[index]!.error = true
    expect(createGate().execute(responses).status).not.toBe(0)
  })

  it.each([0, 1, 2, 3, 4])('fails closed on malformed API response %s', (index) => {
    const responses = responsesFor()
    responses[index]!.raw = 'not JSON'
    expect(createGate().execute(responses).status).not.toBe(0)
  })

  it.each(['failure', 'cancelled', 'success'])(
    'rejects a newer %s attempt between build and deployment',
    (conclusion) => {
      const gate = createGate()
      expect(gate.execute(responsesFor()).status).toBe(0)
      expect(gate.execute(responsesFor({ ...run, run_attempt: 3, conclusion }), 'final').status).not.toBe(0)
    },
  )

  it('rejects a run that becomes unavailable during the build', () => {
    const gate = createGate()
    expect(gate.execute(responsesFor()).status).toBe(0)
    const responses = responsesFor()
    responses[1]!.body = { total_count: 0, workflow_runs: [] }
    expect(gate.execute(responses, 'final').status).not.toBe(0)
  })

  it('rejects the final check without initial CI evidence', () => {
    expect(createGate().execute(responsesFor(), 'final').status).not.toBe(0)
  })

  it.each([{ TARGET_SHA: 'invalid' }, { GITHUB_REPOSITORY: 'other/dashboard' }, { GH_TOKEN: '' }])(
    'rejects invalid gate context without making API requests: %j',
    (overrides) => {
      expect(createGate().execute([], 'initial', overrides).status).not.toBe(0)
    },
  )
})
