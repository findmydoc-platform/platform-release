# Ops-owned Supabase release reconciliation

Ops exclusively owns Supabase desired state, the native-mail suppression SQL function and grants, hosted binding, and
reconciliation. Platform releases must reconcile the complete explicitly managed configuration for Preview, then
Production, using the existing Ops engine and workflow. The exact frozen release approval covers those operations;
standalone configuration applies retain their existing safeguards.

The revised runner contract is tracked in [#37](https://github.com/findmydoc-platform/platform-release/issues/37).
The former Website runtime adapter and dedicated Auth mail cutover/rollback state machine have been removed.
Website documentation will reference Ops ownership. The runner must never receive Supabase or application credentials.

The Ops workflow's versioned call and result contract is still being implemented by its owner. This branch supplies no
speculative dispatch inputs or outcome schema. Its `apply` command stops with a fixed machine-readable error before
reading release files, requesting credentials, or creating a live client. Plan, content, status, manifest compatibility,
and artifact-only recovery retain their existing interfaces while the release integration is pending.

The remaining integration must bind the trusted Ops commit to the frozen plan, reuse exact version/plan/content
confirmations, reconcile every opted-in field and object, and verify real per-environment outcomes before application
deployment or publication. A successful workflow conclusion or mocked result alone cannot establish reconciliation.
Run identity, source binding, complete managed scope, environment isolation, readback, suppression verification,
deterministic resume, and immutable release safety require source tests against the actual Ops contract.

No hosted apply, hook activation, deployment, tag, release, or email delivery is authorized by this preparation.
Full #37 acceptance and merge readiness remain open until the Ops implementation and tested contract are available.
