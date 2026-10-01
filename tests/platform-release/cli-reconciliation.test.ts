import { expect, it } from 'vitest'
import { createProgram } from '../../src/cli.js'

it('blocks apply before credentials or writes while the Ops release contract is unavailable', async () => {
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
      'unavailable-plan.json',
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
        message: 'The Ops release reconciliation contract is unavailable; no Production mutation is permitted.',
      },
    })
    expect(clientsCreated).toBe(0)
  } finally {
    process.exitCode = previousExitCode
  }
})
