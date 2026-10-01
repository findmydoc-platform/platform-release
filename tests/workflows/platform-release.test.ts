import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import { parse } from 'yaml'

type WorkflowStep = {
  readonly env?: Record<string, string>
  readonly id?: string
  readonly name?: string
  readonly run?: string
  readonly uses?: string
  readonly with?: Record<string, string | number | boolean>
}

type WorkflowJob = {
  readonly environment?: string
  readonly if?: string
  readonly needs?: string | readonly string[]
  readonly permissions?: Record<string, string>
  readonly steps?: readonly WorkflowStep[]
}

type Workflow = {
  readonly on?: {
    readonly workflow_dispatch?: {
      readonly inputs?: Record<
        string,
        {
          readonly default?: unknown
          readonly options?: readonly string[]
          readonly required?: boolean
          readonly type?: string
        }
      >
    }
  }
  readonly permissions?: Record<string, string>
  readonly jobs: Record<string, WorkflowJob>
}

const readYaml = async <T>(relativePath: string): Promise<T> =>
  parse(await readFile(new URL(`../../${relativePath}`, import.meta.url), 'utf8')) as T

const readWorkflow = (name: string): Promise<Workflow> => readYaml(`.github/workflows/${name}`)

const namedStep = (workflow: Workflow, jobName: string, stepName: string): WorkflowStep => {
  const step = workflow.jobs[jobName]?.steps?.find((candidate) => candidate.name === stepName)
  expect(step, `Expected ${jobName} to contain the ${stepName} step.`).toBeDefined()
  return step as WorkflowStep
}

const actionStep = (workflow: Workflow, jobName: string, stepName: string): WorkflowStep => {
  const step = namedStep(workflow, jobName, stepName)
  expect(step.uses, `Expected ${jobName}:${stepName} to invoke an action.`).toBeDefined()
  return step
}

const expectFrozenProductionContract = (step: WorkflowStep) => {
  expect(step.env).toMatchObject({
    DEPLOYMENT_COMMIT_SHA: '${{ inputs.target_sha }}',
    DEPLOYMENT_ENVIRONMENT: 'production',
    RELEASE_VERSION: '${{ inputs.platform_version }}',
  })
}

const expectVercelToken = (step: WorkflowStep) => {
  expect(step.env).toMatchObject({
    VERCEL_TOKEN: '${{ secrets.VERCEL_TOKEN }}',
  })
}

describe('platform release workflows', () => {
  it('keeps the trusted main, plan, and apply confirmation gates', async () => {
    const workflow = await readWorkflow('platform-release.yml')
    const inputs = workflow.on?.workflow_dispatch?.inputs
    const trustedRef = namedStep(workflow, 'trusted-ref', 'Reject non-main workflow refs')
    const applyInputs = namedStep(workflow, 'apply', 'Validate apply inputs')
    const applyRelease = namedStep(workflow, 'apply', 'Apply platform release')

    expect(inputs?.mode).toMatchObject({
      default: 'plan',
      options: ['plan', 'apply', 'recover'],
      required: true,
      type: 'choice',
    })
    expect(workflow.jobs.plan).toMatchObject({
      if: "inputs.mode == 'plan'",
      needs: 'trusted-ref',
    })
    expect(workflow.jobs.apply).toMatchObject({
      if: "inputs.mode == 'apply'",
      needs: 'trusted-ref',
    })
    expect(workflow.jobs.recover).toMatchObject({
      if: "inputs.mode == 'recover'",
      needs: 'trusted-ref',
    })
    expect(trustedRef.env).toEqual({ WORKFLOW_REF: '${{ github.ref }}' })
    expect(trustedRef.run).toContain('test "$WORKFLOW_REF" = "refs/heads/main"')
    expect(applyInputs.env).toMatchObject({
      CONFIRM_CONTENT_DIGEST: '${{ inputs.confirm_content_digest }}',
      CONFIRM_DIGEST: '${{ inputs.confirm_digest }}',
      CONFIRM_VERSION: '${{ inputs.confirm_version }}',
      PLAN_RUN_ID: '${{ inputs.plan_run_id }}',
      RELEASE_CONTENT: '${{ inputs.release_content }}',
    })
    expect(applyInputs.run).toContain('[[ "$CONFIRM_DIGEST" =~ ^[0-9a-f]{64}$ ]]')
    expect(applyInputs.run).toContain('[[ "$CONFIRM_CONTENT_DIGEST" =~ ^[0-9a-f]{64}$ ]]')
    expect(applyInputs.run).toContain('[[ "$CONFIRM_VERSION" =~ ^v')
    expect(applyRelease.run).toContain('--confirm-digest "$CONFIRM_DIGEST"')
    expect(applyRelease.run).toContain('--confirm-content-digest "$CONFIRM_CONTENT_DIGEST"')
    expect(applyRelease.run).toContain('--confirm-version "$CONFIRM_VERSION"')
    expect(applyRelease.run).toContain('--apply')
  })

  it('uses least-privilege component access and validates plan provenance', async () => {
    const workflow = await readWorkflow('platform-release.yml')
    const planToken = actionStep(workflow, 'plan', 'Create cross-repository token')
    const applyToken = actionStep(workflow, 'apply', 'Create cross-repository token')
    const provenance = namedStep(workflow, 'apply', 'Verify plan artifact provenance')

    expect(workflow.permissions).toEqual({ actions: 'read', contents: 'read' })
    expect(workflow.jobs.apply?.permissions).toEqual({
      actions: 'read',
      contents: 'read',
      deployments: 'write',
    })
    expect(workflow.jobs.recover?.permissions).toEqual({
      actions: 'read',
      contents: 'read',
      deployments: 'write',
    })
    expect(workflow.jobs.plan?.permissions).toBeUndefined()
    expect(planToken.uses).toBe('actions/create-github-app-token@fee1f7d63c2ff003460e3d139729b119787bc349')
    expect(planToken.with).toMatchObject({
      'permission-contents': 'read',
      'permission-issues': 'read',
      'permission-pull-requests': 'read',
      repositories: 'website\nclinic-dashboard\n',
    })
    expect(applyToken.with).toMatchObject({
      'permission-actions': 'write',
      'permission-contents': 'write',
      'permission-pull-requests': 'read',
      repositories: 'website\nclinic-dashboard\n',
    })
    const opsToken = actionStep(workflow, 'apply', 'Create Ops reconciliation token')
    expect(opsToken.with).toMatchObject({
      'permission-actions': 'write',
      'permission-contents': 'read',
      repositories: 'ops\n',
    })
    expect(opsToken.with?.['permission-contents']).not.toBe('write')
    const opsPlanToken = actionStep(workflow, 'plan', 'Create Ops planning token')
    expect(opsPlanToken.with).toMatchObject({ 'permission-contents': 'read', repositories: 'ops\n' })
    expect(opsPlanToken.with?.['permission-actions']).toBeUndefined()
    expect(provenance.env).toMatchObject({
      CURRENT_SHA: '${{ github.sha }}',
      GH_TOKEN: '${{ github.token }}',
      PLAN_RUN_ID: '${{ inputs.plan_run_id }}',
    })
    expect(provenance.run).toContain('test "$source_branch" = "main"')
    expect(provenance.run).toContain('compare/${source_head_sha}...${CURRENT_SHA}')
    expect(provenance.run).toContain('identical | ahead')
  })

  it('keeps recovery read-only and requires the exact recovery confirmations', async () => {
    const workflow = await readWorkflow('platform-release.yml')
    const recoveryInputs = namedStep(workflow, 'recover', 'Validate recovery inputs')
    const recoveryToken = actionStep(workflow, 'recover', 'Create read-only cross-repository token')
    const recover = namedStep(workflow, 'recover', 'Recover FounderOps handoff and announcement')

    expect(workflow.jobs.recover).toMatchObject({
      if: "inputs.mode == 'recover'",
      needs: 'trusted-ref',
    })
    expect(recoveryToken.with).toMatchObject({
      'permission-actions': 'read',
      'permission-contents': 'read',
      repositories: 'website\nclinic-dashboard\n',
    })
    expect(recoveryToken.with?.['permission-actions']).not.toBe('write')
    expect(recoveryToken.with?.['permission-contents']).not.toBe('write')
    expect(recoveryInputs.run).toContain('Recovery confirmation has an unsupported key set.')
    expect(recover.run).toContain('--confirm-manifest-digest "$CONFIRM_MANIFEST_DIGEST"')
    expect(recover.run).toContain('--confirm-missing-manifest-repository "$CONFIRM_MISSING_MANIFEST_REPOSITORY"')
    expect(recover.run).toContain('--confirm-mutable-manifest-repository "$CONFIRM_MUTABLE_MANIFEST_REPOSITORY"')
    expect(recover.run).toContain('--apply')
  })

  it.each(['reusable-deploy-dashboard.yml', 'reusable-deploy-website.yml'])(
    'checks out and validates the frozen production contract in %s',
    async (name) => {
      const workflow = await readWorkflow(name)
      const checkout = workflow.jobs.deploy?.steps?.find((step) => step.uses?.startsWith('actions/checkout@'))
      const validation = namedStep(workflow, 'deploy', 'Validate release inputs')
      const frozenSha = namedStep(workflow, 'deploy', 'Verify frozen SHA belongs to main')

      expect(checkout?.with).toMatchObject({
        'fetch-depth': 0,
        'persist-credentials': false,
        ref: '${{ inputs.target_sha }}',
      })
      expect(validation.env).toMatchObject({
        DEPLOYMENT_COMMIT_SHA: '${{ inputs.target_sha }}',
        DEPLOYMENT_ENVIRONMENT: 'production',
        PLAN_DIGEST: '${{ inputs.plan_digest }}',
        RELEASE_VERSION: '${{ inputs.platform_version }}',
      })
      expect(validation.run).toContain('[[ "$DEPLOYMENT_COMMIT_SHA" = "$TARGET_SHA" ]]')
      expect(validation.run).toContain('[[ "$RELEASE_VERSION" = "$PLATFORM_VERSION" ]]')
      expect(frozenSha.run).toContain('git merge-base --is-ancestor "$TARGET_SHA" origin/main')
    },
  )

  it('keeps the dashboard Vercel execution inside the platform workflow', async () => {
    const workflow = await readWorkflow('reusable-deploy-dashboard.yml')
    const helper = namedStep(workflow, 'deploy', 'Prepare platform Vercel helper')
    const build = namedStep(workflow, 'deploy', 'Build Vercel production')
    const deploy = namedStep(workflow, 'deploy', 'Deploy Vercel production')

    expectFrozenProductionContract(build)
    expectFrozenProductionContract(deploy)
    expectVercelToken(deploy)
    expect(helper.run).toContain('cat > "$RUNNER_TEMP/dashboard-vercel-deployment.sh"')
    expect(build.run).toBe('"$RUNNER_TEMP/dashboard-vercel-deployment.sh" build production')
    expect(deploy.run).toBe('"$RUNNER_TEMP/dashboard-vercel-deployment.sh" deploy production')
  })

  it('keeps the website deployment boundary explicit', async () => {
    const workflow = await readWorkflow('reusable-deploy-website.yml')
    const deploy = namedStep(workflow, 'deploy', 'Deploy Vercel production')

    expectFrozenProductionContract(deploy)
    expectVercelToken(deploy)
    expect(deploy.run).toContain('deploy --prebuilt --prod --yes')
  })
})
