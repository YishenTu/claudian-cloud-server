# Project authority

## Ownership

- This scope is the policy owner for Project admission, membership and role authorization, managed eligibility evaluation, business idempotency, mutation ordering, lifecycle transitions, and cross-store recovery.
- Derive membership from the accepted ingress actor and current Project state. Never trust client or ingress assertions of membership, role, eligibility, service state, or repository placement.
- Business idempotency is scoped to Project membership and operation intent; device/session attribution is audit context, not a separate business actor.
- Transport, PostgreSQL queries, repository paths, and raw Git commands remain behind their owning modules.

## Mutation contract

- Every Project mutation enters the same write lane and canonical PostgreSQL advisory-lock key. Before new work, resolve or isolate every non-terminal cross-store journal.
- Revalidate membership, role, service state, expected revisions, expected OIDs, and placement lease at the last boundary before the first irreversible effect.
- Cross-store operations persist a deterministic pre-effect checkpoint, record possible and confirmed progress, use expected-OID CAS, and finalize idempotently. Never infer success from a missing file or lost response.
- Reads may run concurrently only when they cannot expose a mixed authoritative snapshot. Membership changes re-evaluate queued work and event access.

## Lifecycle scope

- Implement only lifecycle operations advertised by the current milestone. Before adding creation, migration, backup, deletion, Leave, Retire, or authority handoff, record its exact durable phases, visibility, cleanup, cancellation, and recovery contract in `ARCHITECTURE.md`.
- Tests inject failure after every durable phase and prove same-Project exclusion, different-Project progress, exact replay, and fail-closed recovery.
