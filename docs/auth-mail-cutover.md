# Auth mail cutover preparation

The runner owns frozen release orchestration and durable release phases. Website owns the no-op suppression source,
runtime verification, Supabase access, and Auth command availability. ADR 032 permits the hook only as a suppression
control. Lettermint remains the only transactional transport; this runner has no Supabase, application, or provider
credential and generates no Auth links or email content.

## Unresolved protected adapter

The Website source at `a224a99e7b9648f6fab6c4b826189e62e1aafa86` contains
`supabase/native-mail-suppression.json`, its migration, and `scripts/supabase-native-mail-suppression.mjs`.
That validator verifies desired repository state. It supplies no hosted binding evidence.
The Website `platform-release-deploy.yml` caller accepts only `target_sha`, `platform_version`, and `plan_digest`.
It has no protected runtime preflight, cutover, rollback, or rollback verification adapter.

Additional Website interface implementation is on hold. This repository supplies no such interface and changes no
Website or Ops file, hook binding, credential, activation, deployment, provider, tag, release, or email delivery.
The default CLI's `createAuthMailClient` returns `undefined`; bound apply and rollback stop before a Production mutation.
`platform-release-auth-mail.yml` in the trusted configuration identifies the required future Website-owned workflow,
not an existing or runnable workflow. Supplying configuration alone cannot activate this runner.

Unit fixtures exercise the runner's proposed adapter boundary. They do not prove that a hosted environment satisfies
the contract. Completing #37 requires a separately authorized Website adapter and reviewed wiring to that adapter,
followed by its protected-workflow evidence. No product-flow replacement or live configuration is implied.

## Frozen source and compatibility

Planning reads the declaration, migration, and ADR from the exact frozen Website commit. The closed no-op declaration
and migration check reject broader permissions, imports, network calls, payload use, rendering, logging, and extra SQL.
Separate hashes bind the declaration, migration, approved ADR, function, and permissions into the existing plan digest.
The plan contains only a non-secret ownership identifier, workflow name, Website SHA, and fingerprints. It contains no
SQL, endpoint, project credential, identity, recipient, token, action link, or message content.

Plan schema 2 remains readable. Existing content and Manifest v2/v3 formats remain unchanged. Artifact-only legacy
recovery retains its existing contract. Applying a legacy plan with the trusted Auth mail configuration requires a new
approved plan containing the suppression binding. Historical artifacts cannot silently authorize a new cutover.

## Required runtime boundary

`AuthMailCutoverClient` is an injected boundary for the separately owned protected Website workflow. Implementations
must use the frozen Website source and environment-specific ownership record. They must not trust runner-supplied
Boolean assertions as evidence. The Website workflow must verify its dispatch authority and trusted revision, serialize
Production operations with application deployment, and expose only the closed content-free result.

| Operation        | Required behavior                                                                                                                                                                                                                                          |
| ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `preflight`      | Read-only verification of the intended Production project, required permission, enabled email provider, absence of Custom SMTP, non-exposed suppression schema, installed function and effective permissions, hook identity/state, and current fingerprint |
| `cutover`        | Idempotently bind or reconcile the approved no-op hook, preserve the enabled email provider, and return the verified enabled state; never install a sending hook, SMTP, retry, or fallback transport                                                       |
| `rollback`       | Disable only the new affected Auth command activations and their preparation/dispatch while retaining verified suppression; leave conversation, moderation, and existing clinic-registration commands unchanged                                            |
| `verifyRollback` | Read the deployed application SHAs and command gates again; prove the frozen pre-release SHAs, disabled affected Auth commands, unchanged other commands, and enabled suppression                                                                          |

Every preflight/cutover result must match `AuthMailEvidence` exactly. It binds the approved plan/content and frozen source
through their digests, identifies Production, confirms rights and schema exposure, matches function/permission
fingerprints, identifies the known no-op function, and rejects Custom SMTP. An enabled hook requires a successful
synthetic native-mail suppression check with zero external network requests and zero delivered emails. Disabled or
unbound suppression is acceptable only before cutover. Unknown bindings, missing proof, extra fields, or stale/mismatched
digests fail closed. Runtime proof must establish the environment-specific enabled binding and effective grants;
repository fingerprints alone cannot establish them.

The negative check must exercise the Auth native-mail path in an isolated synthetic boundary. It must not substitute
administrative action-link generation, a declaration check, or successful provider delivery for suppression evidence.
It must expose no real identity, recipient, token, template data, raw hook event, private address, or endpoint.

## Release phases and resume

The GitHub state store records a non-production deployment in `auth-mail-cutover` in the public runner repository.
Its identity includes plan/content/source-binding digests and version. Status descriptions contain only a validated
phase and whether explicit rollback was requested. Duplicate identities, conflicting content, or malformed state stop
the runner. The store reads all status pages; any recorded explicit rollback remains permanent even if a stale apply
later appends another phase. The store uses the existing separate `GITHUB_STATE_TOKEN` in Actions or the operator's local GitHub identity;
it receives no application credentials.

Phases are `preflight-pending`, `cutover-ready`, `cutover-applied`, `deploying`, `deployed`, `release-pending`, `published`,
and `rollback-required`. The runner records an ambiguous cutover attempt before requesting the mutation so interruption
cannot erase that boundary. It reads suppression again after cutover. A fresh read-only preflight precedes each
application deployment, draft, publication metadata write, manifest upload, publication, ingestion, and announcement.
No draft exists before confirmed cutover and both successful deployments.

Resume uses the same plan and content digests. Fresh verified enabled suppression avoids another cutover; successful
frozen deployment runs and matching releases retain their existing identities. Drift stops further mutations. A failure
after cutover retains suppression and requires operator recovery. There is no automatic rollback. Publication followed
by ingestion failure remains `published` and can resume ingestion; it does not authorize rollback. An attempted or
partial publication retains `release-pending`. Resume after confirmed cutover requires active suppression and never
repairs a disabled hook. Each mutation also checks whether an explicit rollback has stopped the running apply.

`status --plan <path> --content <path> --json` reports recorded phases with `fresh: false` and adapter availability.
Recorded status never authorizes a Production mutation or claims current hosted verification.

## Explicit rollback

`rollback` defaults to read-only inspection. Mutation additionally requires `--apply`, the exact plan/content/version
confirmations, and `--confirm-rollback-digest`. The separate rollback digest binds both frozen pre-release application
SHAs to the approved release identity. Every published version, including a partially published immutable version,
blocks rollback and requires corrective release handling.

The runner requests Auth command disablement, deploys the frozen previous SHAs, and requires separate readback of actual
application SHAs, command gates, and suppression. It creates no tag, draft, release, or announcement. Once explicit
rollback is recorded, the original plan cannot be applied again; reactivation requires a new approved corrective plan
and the Website-owned activation checks. An interrupted explicit rollback can resume with the same confirmations.

## Acceptance evidence still required

The runner unit tests cover source binding, malformed/conflicting state, preflight drift, ambiguous cutover failure,
deployment failures, release gating, resume, rollback confirmation, frozen rollback targets, and immutable publication.
They preserve the legacy release/manifest tests. They use synthetic GitHub and protected-adapter boundaries only.

The absent Website adapter still blocks actual environment/permission/provider/SMTP verification, hook application and
readback, Auth-side negative native-mail proof, command-disablement proof, protected dispatch/serialization, and
restored application/command verification. Full #37 acceptance and merge readiness remain unproven while that interface
is on hold. Preview and Production retain independent configuration and evidence; no Preview evidence satisfies this
Production contract.
