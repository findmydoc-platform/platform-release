# findmydoc release automation

Public, GitHub-native automation for publishing coordinated findmydoc platform releases and preparing verified release history for registered applications.

This repository contains only the deterministic release engine, reusable deployment workflows, configuration derived from public repository metadata, and automated tests. It contains no credentials, private operational context, or internal runbooks.

Internal operating documentation is maintained in the Operations repository.

Platform release plans freeze both application commits. Deployment and publication do not inspect or change
Supabase Auth configuration. Auth emails belong to the central transactional mail service; Ops owns the separate
Auth configuration. See [configuration ownership and historical evidence](docs/supabase-reconciliation.md).

## GitHub release notes

New platform content templates include `githubSummaries` with `dashboard` and `website` introductions. Write two or three short English technical sentences per component, each on one line of at most 600 characters. The renderer builds native-style `What's Changed` lists from the frozen repository PRs and uncovered commits, plus a `Full Changelog` comparison link. It makes no additional GitHub requests to generate these notes.

`content --json` returns both rendered notes in `githubReleaseNotes` for the same approval view. Both introductions are covered by the existing content digest. The German product summary and changes remain the FounderOps narrative; GitHub introductions are not copied into the manifest. Content without `githubSummaries` retains its original GitHub rendering and digest for historical retries and recovery. Release import content is unchanged.

## Dashboard CI evidence

The Dashboard deployment reuses the existing successful main CI run for the exact frozen `target_sha`.
It requires one unambiguous `push` run of the active `.github/workflows/ci.yml` workflow on `main`,
validates the repository and current run attempt, and rejects missing, pending, failed, cancelled, or inconsistent evidence immediately.
It never dispatches CI, reruns tests, or waits for CI completion. Existing CI path routing and test selection remain authoritative.

The pinned reusable workflow checks the current CI evidence once, immediately before the production upload.
Callers must grant the deployment job `actions: read` and `contents: read`.
Application and Vercel production builds, deployment metadata, and existing release protection checks remain required.

## Website package access

The Website reusable deployment workflow requires the caller secret `GH_PACKAGES_READ_TOKEN` with private package read access.
It exposes that credential as `NODE_AUTH_TOKEN` only while the runner installs and builds the frozen Website checkout through
`vercel build --prod`. The upload uses the prebuilt output; upload, alias, and runtime configuration do not receive the package token.
Callers keep the token in GitHub Actions secrets and must not add it to a Vercel project environment variable.
The Website workflow disables package-manager caching and uses no Actions cache for its install or build output.
Fork pull requests can read default-branch Actions caches, so private package files must never enter those caches.

## Release manifests

- Manifest v2 remains readable for existing joint releases.
- Manifest v3 models either one registered application (`releaseMode: application`) or a platform release with at least two registered applications (`releaseMode: platform`).
- Components must match the versioned catalog in `config/platform-release.json`.
- Deployment evidence is optional in v3 and is never fabricated.
- Imported GitHub releases use `notificationMode: silent`; native releases use `standard`.

## Release titles and summaries

New native content templates include a German `title` of at most 65 characters. With a title present, the German `summary` has at most 160 characters and each change title has at most 65. Change descriptions keep their existing 360-character limit. Write one or two short summary sentences that explain the main benefit and availability. Rewrite text that exceeds a limit; the runner does not truncate it.

The optional title is part of the content digest and Manifest v3 digest. Deploy a compatible FounderOps consumer before adopting this runner for new titled content. FounderOps displays the title separately from the summary and uses the version as the heading for older releases. GitHub release titles and notification titles remain version-based.

Titleless content keeps its previous limits, serialized fields, and digests. Manifest v2 and release imports are unchanged. Do not add a title when retrying an approved historical release.

## Local release import

The import path is intentionally separate from publication. It cannot create tags, GitHub Releases, deployments, or chat messages.

```bash
pnpm platform-release import-releases plan --help
pnpm platform-release import-releases build --help
pnpm platform-release import-releases ingest --help
```

`plan` reads published GitHub Releases and exact linear tag ranges. Repeating it against unchanged GitHub state reuses the existing immutable plan and its original timestamp. Any release-note discrepancy must be acknowledged byte-for-byte in `release-content.json`; the acknowledgement is therefore covered by the content and manifest digests. `build` accepts reviewed German content and writes immutable Manifest v3 files plus a batch index of no more than eight releases. `ingest` requires both `--apply` and the exact batch digest, then sends only the stored manifests to the configured FounderOps endpoint.

The generic announcement command accepts only native platform manifests with standard notifications. The immutable manifest-gap recovery path supports both legacy Manifest v2 archives and current native Manifest v3 archives with their exact stable publication timestamp.
