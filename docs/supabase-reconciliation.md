# Ops-owned Supabase release reconciliation

Ops owns the complete explicitly managed Supabase desired state and its reconciliation engine. Approved platform
releases invoke the existing `supabase-auth-config.yml` workflow for Preview, then Production, before application
deployments or release publication. Supabase credentials, SQL execution, configuration writes, and standalone apply
confirmations remain in Ops.

## Frozen approval and source

`plan` freezes the trusted Ops `main` commit, workflow digest, instance/profile identities, project-reference digests,
and complete managed field names in `supabaseReconciliation`. This scope contributes to the plan digest. The supported
Ops v1 inventory opts staging and production into the shared mail profile, Auth routing, and native mail suppression.
Unknown managed fields or instance options block planning until the Runner supports them.

The exact existing version, plan digest, and approved content digest authorize both environment reconciliations.
Dispatch uses `operation=apply`, `apply_changes=true`, and `release_context` JSON with exactly these fields:

| Field         | Value                                                |
| ------------- | ---------------------------------------------------- |
| schemaVersion | 1                                                    |
| environment   | preview or production                                |
| version       | approved vX.Y.Z                                      |
| planDigest    | approved 64-character lowercase hexadecimal digest   |
| contentDigest | approved 64-character lowercase hexadecimal digest   |
| opsSha        | frozen 40-character lowercase hexadecimal commit SHA |

Ops maps Preview to staging and `preview-platform`, and Production to production and `production-platform`. It checks
out the frozen SHA and verifies trusted ancestry before executing configuration code or resolving credentials.
Standalone applies retain their dry-run default and confirmation gates.

Legacy plans remain readable for historical manifest recovery and imports. `apply` requires a newly approved plan with
the binding. Already published releases cannot acquire missing reconciliation evidence through a new dispatch.

Immediately before each new dispatch, the Runner requires current Ops `main` to equal the approved Ops SHA and checks
its workflow bytes. An Ops commit advancing before a pending dispatch requires a new frozen plan and release approval.
Recorded runs can still resume against their original frozen source. The main-only Ops-v1 API does not atomically bind
the GET preflight to the POST dispatch; enforcement before credentials also requires an Ops-side execution-head guard.
Protected trusted `main` remains the source trust boundary. A guard inside an arbitrarily replaced privileged workflow
cannot secure that replacement. Source preparation alone does not prove this operational boundary.

## Verified outcomes

The Runner pins the [GitHub dispatch API](https://docs.github.com/en/rest/actions/workflows#create-a-workflow-dispatch-event)
to version `2026-03-10`, which returns an exact run ID. It verifies the main branch, exact approved head SHA, workflow bytes,
event, title, attempt, URL, and successful conclusion. It downloads the unique, unexpired
`supabase-auth-config-<run-id>-<run-attempt>` artifact and verifies every file's checksum.

`release-context.json`, `github-run.json`, and `operator-result.json` must bind the same approval, frozen source,
environment, inventory target, and current attempt. Only `applied` or `noop` qualify. Suppression function and permission
checks must both be true and converged. Every managed field must appear once, report convergence, and have matching
desired and remote fingerprints:

- `hook_send_email_enabled` and `hook_send_email_uri`
- `mailer_subjects_invite` and `mailer_subjects_recovery`
- `mailer_templates_invite_content` and `mailer_templates_recovery_content`
- `site_url` and `uri_allow_list`

Ops verifies suppression SQL and grants before changing the hook, then reads back the managed Auth configuration.
A green workflow, dry-run, drift report, incomplete artifact, or mismatched context never qualifies. The Runner stops
before the next environment or application mutation.

`supabase-reconciliation.json` records approval digests, Ops SHA, run IDs/attempts/URLs, artifact identities/digests,
result digests, field names, and verification status. It excludes raw project references, configuration values, SQL,
and credentials. The CLI writes it before application deployment; the workflow archives it for 90 days.
Manifest v2/v3 contracts remain unchanged. Reconciliation evidence is a separate approval-bound artifact.

## Resume and read-only status

A durable GitHub deployment journal in the Runner repository maps each exact release context/environment to one Ops
run ID. It uses `supabase-release-preview` and `supabase-release-production` with `production_environment=false`.
Journal statuses stay `in_progress`: recording an invocation does not attest remote convergence. The existing
`platform-release` workflow concurrency group serializes applies. Local operators must use one apply caller per
approved context; the journal rejects duplicate intents and conflicting IDs.

The Runner writes an intent before dispatch and records the returned ID before polling. Resume always uses that ID.
Timeouts, Ops failures, and later application/publication failures cannot trigger a replacement Ops dispatch.
After investigating a failed apply, rerun its original workflow and resume the same approved plan/content.
The Runner verifies the new attempt and artifact. It never rolls back configuration automatically.

An intent without a run ID is ambiguous. Inspect the attempted dispatch and approval-bound audit before repairing
the journal. There is no force-redispatch flag. Missing or expired original evidence blocks published-release resume.
Artifact-only legacy recovery retains its existing limited authority.

```bash
pnpm platform-release status --plan plan.json --content release-content.json --json
```

Status reads the journal and existing runs/artifacts without writes or dispatches. It reports unknown, pending,
ambiguous, running, failed, blocked, or verified evidence per environment. Without approved content, exact invocation
lookup is unavailable. All status evidence reports `fresh=false`; it does not claim a fresh remote Supabase inspection.

## Operational prerequisites and evidence limits

The release GitHub App must be installed for `findmydoc-platform/ops`. Planning requests an Ops-only Contents read
token. Apply requests a separate Ops-only Contents read and Actions write token. Application Contents write remains
on its own token. The Runner workflow token needs Deployments write for the journal. Local callers may use their
configured GitHub identity; `GITHUB_OPS_TOKEN` selects an Ops identity and `GITHUB_STATE_TOKEN` selects a journal identity.

The App installation and grant check remains an operational prerequisite. Operator `gh` access and standalone Ops
dry-runs do not verify Runner App permissions. This preparation does not extract App secrets or perform live apply.
A supported installation check or authorized hosted invocation must establish those permissions before operational use.

The outcome attests suppression function/grants/hook and the opted-in Auth fields above. Unowned provider, SMTP,
Data API schema exposure, and synthetic native-mail delivery behavior are outside this contract. Suppression booleans
cannot prove them. Hosted read-only dry-runs establish connectivity and report drift, not applied release convergence.
Full release acceptance requires a real approved apply and verified artifacts.

Implementation references are [Runner #37](https://github.com/findmydoc-platform/platform-release/issues/37) and
[Ops #76](https://github.com/findmydoc-platform/ops/issues/76). The Ops v1 contract was inspected at
`f3deafd54970e4fad48a1e59cc24e39e0b4c8b3f`. New plans freeze current trusted source rather than permanently pinning future
releases to that adoption commit.
