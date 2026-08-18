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
  repositories: Record<string, PlatformReleaseRepositoryConfig> & Record<PlatformRepositoryKey, PlatformReleaseRepositoryConfig>
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
  body: string
  draft: boolean
  id: number
  immutable: boolean
  manifestAttached: boolean
  platformPublishedAt?: string
  preparedAt: string
  publishedAt?: string
  sha: string
  url: string
}

export type PlatformReleaseAnnouncementStore = {
  getState(manifestDigest: string): Promise<ReleaseAnnouncementState | undefined>
  setState(input: {
    founderOpsUrl?: string
    manifestDigest: string
    state: ReleaseAnnouncementState
    version: string
  }): Promise<void>
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

export type ReleaseMode = 'application' | 'platform'
export type ReleaseNotificationMode = 'silent' | 'standard'

export type ReleaseContentChangeV3 = {
  commitShas: string[]
  componentKeys: string[]
  id: string
  kind: ReleaseContentKind
  pullRequests: ReleaseContentPullRequestReference[]
  summary: string
  title: string
  visualUrls: string[]
}

export type ReleaseContentV3 = {
  changes: ReleaseContentChangeV3[]
  highlights: string[]
  reviewAcknowledgements: string[]
  schemaVersion: 2
  summary: string
}

export type PlatformReleaseManifestV3 = {
  changes: ReleaseContentChangeV3[]
  components: Array<Omit<PlatformReleaseManifestComponent, 'deploymentRun' | 'key'> & {
    deploymentRun: string | null
    key: string
  }>
  contentDigest: string
  highlights: string[]
  manifestDigest: string
  notificationMode: ReleaseNotificationMode
  planDigest: string
  publishedAt: string
  releaseMode: ReleaseMode
  schemaVersion: 3
  source: { kind: 'native' } | { importedAt: string; kind: 'github-release-import' }
  summary: string
  version: string
  visuals: ReleaseVisual[]
}

export type ReleaseManifest = PlatformReleaseManifestV2 | PlatformReleaseManifestV3

export type ImportedGitHubRelease = {
  body: string
  publishedAt: string
  releaseUrl: string
  targetSha: string
  version: string
}

export type ReleaseImportGitHubClient = {
  compareCommits(repository: string, base: string, head: string): Promise<ReleaseCommit[]>
  getAllCommits(repository: string, head: string): Promise<ReleaseCommit[]>
  getPublishedReleases(repository: string): Promise<ImportedGitHubRelease[]>
  getPullRequests(repository: string, commits: ReleaseCommit[]): Promise<ReleasePullRequest[]>
}

export type ReleaseImportPlan = {
  component: {
    displayName: string
    key: string
    productionUrl: string
    repository: string
  }
  createdAt: string
  deploymentRun: string | null
  digest: string
  orphanCommits: string[]
  previousVersion: string | null
  publishedAt: string
  pullRequests: ReleasePullRequest[]
  range?: {
    kind: 'commits' | 'identical' | 'initial'
    previousTargetSha: string | null
  }
  releaseNotes: string
  releaseUrl: string
  reviewRequired: string[]
  schemaVersion: 1 | 2
  targetSha: string
  commits: ReleaseCommit[]
  version: string
}

export type ReleaseImportBatch = {
  digest: string
  releases: Array<{
    manifestDigest: string
    manifestPath: string
    version: string
  }>
  schemaVersion: 1
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
  createDraftRelease(input: {
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
  getReleaseManifest(repository: string, version: string): Promise<string | undefined>
  isAncestor(repository: string, ancestor: string, branch: string): Promise<boolean>
  publishRelease(input: { repository: string; releaseId: number; version: string }): Promise<PlatformReleaseDetails>
  setReleasePlatformPublishedAt(input: {
    platformPublishedAt: string
    releaseId: number
    repository: string
    version: string
  }): Promise<PlatformReleaseDetails>
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
