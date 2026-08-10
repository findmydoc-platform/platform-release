export type PlatformRepositoryKey = 'dashboard' | 'website'

export type PlatformReleaseRepositoryConfig = {
  branch: string
  cutoverSha?: string
  deploymentWorkflow: string
  productionUrl: string
  repository: string
  surface: string
}

export type PlatformReleaseConfig = {
  platformBaselineVersion: string
  repositories: Record<PlatformRepositoryKey, PlatformReleaseRepositoryConfig>
  schemaVersion: 1
}

export type ReleaseBump = 'major' | 'minor' | 'none' | 'patch'

export type ReleaseCommit = {
  bump: ReleaseBump
  message: string
  sha: string
  url: string
}

export type ReleaseIssue = {
  number: number
  repository: string
  title: string
  url: string
}

export type ReleaseVisual = {
  altText: string
  formFactor: 'desktop' | 'mobile' | 'tablet'
  label: string
  releaseEligible: boolean
  releaseRole?: 'primary' | 'secondary'
  repository: string
  pullRequestNumber: number
  source: 'body' | 'screenshots' | 'ui-ux' | 'ui-ux-marker'
  url: string
}

export type ReleasePullRequest = {
  body: string
  issues: ReleaseIssue[]
  number: number
  repository: string
  title: string
  url: string
  visuals: ReleaseVisual[]
}

export type PlatformReleaseRepositoryPlan = {
  base: {
    kind: 'cutover' | 'release'
    sha: string
    version?: string
  }
  branch: string
  commits: ReleaseCommit[]
  deploymentWorkflow: string
  productionUrl: string
  pullRequests: ReleasePullRequest[]
  repository: string
  surface: string
  targetSha: string
}

export type PlatformReleasePlan = {
  breakingChanges: Array<{
    message: string
    repository: string
    sha: string
  }>
  createdAt: string
  digest: string
  highestBump: ReleaseBump
  manualVersion: boolean
  repositories: Record<PlatformRepositoryKey, PlatformReleaseRepositoryPlan>
  schemaVersion: 1
  version: string
  visualCandidates: ReleaseVisual[]
}

export type WorkflowRun = {
  conclusion: string | null
  databaseId: number
  displayTitle: string
  status: string
  url: string
}

export type ReleaseAnnouncementState = 'pending' | 'sent'

export type PlatformReleaseDetails = {
  announcementState?: ReleaseAnnouncementState
  id: number
  sha: string
  url: string
}

export type PlatformReleaseGitHubClient = {
  addIssueComment(input: { body: string; issue: ReleaseIssue }): Promise<void>
  compareCommits(repository: string, base: string, head: string): Promise<ReleaseCommit[]>
  createRelease(input: {
    body: string
    repository: string
    targetSha: string
    version: string
  }): Promise<{ id: number; url: string }>
  dispatchWorkflow(input: {
    branch: string
    inputs: Record<string, string>
    repository: string
    workflow: string
  }): Promise<void>
  findIssueComment(input: { issue: ReleaseIssue; marker: string }): Promise<boolean>
  findWorkflowRun(input: {
    branch: string
    repository: string
    title: string
    workflow: string
  }): Promise<WorkflowRun | undefined>
  getBranchSha(repository: string, branch: string): Promise<string>
  getLatestRelease(repository: string): Promise<{ sha: string; version: string } | undefined>
  getPullRequests(repository: string, commits: ReleaseCommit[]): Promise<ReleasePullRequest[]>
  getRelease(repository: string, version: string): Promise<PlatformReleaseDetails | undefined>
  isAncestor(repository: string, ancestor: string, branch: string): Promise<boolean>
  setReleaseAnnouncementState(input: {
    repository: string
    state: ReleaseAnnouncementState
    version: string
  }): Promise<void>
  uploadReleaseManifest(input: {
    manifest: string
    repository: string
    version: string
  }): Promise<void>
}

export type PlatformReleaseApplyResult = {
  announcement: 'already_sent' | 'sent' | 'skipped'
  digest: string
  releases: Record<PlatformRepositoryKey, { url: string }>
  status: 'published'
  version: string
  workflows: Record<PlatformRepositoryKey, WorkflowRun>
}
