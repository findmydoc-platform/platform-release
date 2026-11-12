# Auth configuration ownership

Auth emails are delivered by the central transactional mail service. The native Supabase Auth mail path is
suppressed by the configured hook. Auth site URLs and redirect allowlists describe the application's allowed
return destinations.

Ops owns this configuration and the standalone `supabase-auth-config.yml` workflow. Platform release planning,
deployment and publication do not inspect or change it. Auth configuration work has its own explicit scope;
a routine application release does not imply that work.

## Historical release evidence

Earlier runners included an approval-bound `supabaseReconciliation` scope in release plans and applied it before
deployment. Those archived plans and artifacts retain their original meaning. This runner reads their evidence
for status and recovery but does not reinterpret or apply their bound Auth scope. Resuming such an apply uses
the original runner and approved inputs.

Current plans contain application provenance and release content only. Their version, plan digest and content
digest continue to bind deployment and publication.
