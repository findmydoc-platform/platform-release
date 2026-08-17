# findmydoc release automation

Public, GitHub-native automation for publishing coordinated findmydoc platform releases and preparing verified release history for registered applications.

This repository contains only the deterministic release engine, reusable deployment workflows, configuration derived from public repository metadata, and automated tests. It contains no credentials, private operational context, or internal runbooks.

Internal operating documentation is maintained in the Operations repository.

## Release manifests

- Manifest v2 remains readable for existing joint releases.
- Manifest v3 models either one registered application (`releaseMode: application`) or a platform release with at least two registered applications (`releaseMode: platform`).
- Components must match the versioned catalog in `config/platform-release.json`.
- Deployment evidence is optional in v3 and is never fabricated.
- Imported GitHub releases use `notificationMode: silent`; native releases use `standard`.

## Local release import

The import path is intentionally separate from publication. It cannot create tags, GitHub Releases, deployments, or chat messages.

```bash
pnpm platform-release import-releases plan --help
pnpm platform-release import-releases build --help
pnpm platform-release import-releases ingest --help
```

`plan` reads published GitHub Releases and exact linear tag ranges. Repeating it against unchanged GitHub state reuses the existing immutable plan and its original timestamp. Any release-note discrepancy must be acknowledged byte-for-byte in `release-content.json`; the acknowledgement is therefore covered by the content and manifest digests. `build` accepts reviewed German content and writes immutable Manifest v3 files plus a batch index of no more than eight releases. `ingest` requires both `--apply` and the exact batch digest, then sends only the stored manifests to the configured FounderOps endpoint.

The generic announcement command accepts only native platform manifests with standard notifications. The immutable manifest-gap recovery path supports both legacy Manifest v2 archives and current native Manifest v3 archives with their exact stable publication timestamp.
