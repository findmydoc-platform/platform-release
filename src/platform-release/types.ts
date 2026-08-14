export type PlatformRepositoryKey = 'dashboard' | 'website'

export type PlatformReleaseRepositoryConfig = {
  branch: string
  cutoverSha?: string
  deploymentWorkflow: string
  displayName: string
  productionUrl: string
  repository: string
  surface: string
}

export type PlatformReleaseConfig = {
  founderOps: {
    baseUrl: string
    ingestPath: string
  }
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
  commitShas: string[]
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
  schemaVersion: 2
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
  body: string
  id: number
  publishedAt: string
  sha: string
  url: string
}

export type ReleaseContentSection = 'dashboard' | 'platform' | 'public'
export type ReleaseContentKind = 'feature' | 'fix' | 'maintenance'

export type ReleaseContentPullRequestReference = {
  number: number
  repository: string
}

export type ReleaseContentChange = {
  id: string
  kind: ReleaseContentKind
  pullRequests: ReleaseContentPullRequestReference[]
  section: ReleaseContentSection
  summary: string
  title: string
  visualUrls: string[]
}

export type PlatformReleaseContent = {
  changes: ReleaseContentChange[]
  highlights: string[]
  schemaVersion: 1
  summary: string
}

export type PlatformReleaseManifestComponent = {
  commits: ReleaseCommit[]
  deploymentRun: string
  displayName: string
  key: PlatformRepositoryKey
  productionUrl: string
  pullRequests: Array<Omit<ReleasePullRequest, 'body' | 'visuals'>>
  release: string
  repository: string
  targetSha: string
}

export type PlatformReleaseManifestV2 = {
  changes: ReleaseContentChange[]
  components: PlatformReleaseManifestComponent[]
  contentDigest: string
  highlights: string[]
  manifestDigest: string
  planDigest: string
  publishedAt: string
  schemaVersion: 2
  summary: string
  version: string
  visuals: ReleaseVisual[]
}

export type FounderOpsIngestResult = {
  replayed: boolean
  url: string
}

export type FounderOpsReleaseClient = {
  ingestManifest(input: {
    manifest: string
    manifestDigest: string
  }): Promise<FounderOpsIngestResult>
}

export type PlatformReleaseGitHubClient = {
  compareCommits(repository: string, base: string, head: string): Promise<ReleaseCommit[]>
  createRelease(input: {
    body: string
    repository: string
    targetSha: string
    version: string
  }): Promise<PlatformReleaseDetails>
  dispatchWorkflow(input: {
    branch: string
    inputs: Record<string, string>
    repository: string
    workflow: string
  }): Promise<void>
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
  ensureReleaseManifest(input: {
    manifest: string
    repository: string
    version: string
  }): Promise<void>
}

export type PlatformReleaseApplyResult = {
  announcement: 'already_sent' | 'sent' | 'skipped'
  contentDigest: string
  digest: string
  founderOps: FounderOpsIngestResult
  manifestDigest: string
  releases: Record<PlatformRepositoryKey, { url: string }>
  status: 'published'
  version: string
  workflows: Record<PlatformRepositoryKey, WorkflowRun>
}
