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
- Development activation advances only through `publish-intent`, `repository-published`, `activated`, and `completed`; the Project becomes visible and authoritative only at `activated`. Cancellation advances through `cancel-intent`, `cancelled`, or `recovery-required` and cannot take ownership after `publish-intent`.
- Development bundle staging acquires its process-local gate and atomically hands the canonical Project lock to an attempt-scoped PostgreSQL shared upload fence before streaming. After persisting settlement intent, Project authority closes the local gate, aborts staging, drains the matching exclusive database fence, and only then publishes or deletes the attempt artifact.
- Accept advances only through `prepared`, `result-persisted`, `main-updated`, and `completed`. Its deterministic commit plan is durable at `prepared`, its verified result OID is durable before protected-main CAS, and ordinary cancellation cannot own it afterward.
- Accept reserves its Project-scoped Git child before acquiring the canonical Project lease and holds that reservation through inspection and settlement. Do not acquire Git capacity from inside the lease: receive-pack uses the same capacity-before-lease order, and inversion can deadlock the Project.
- Receive-pack resolves pending recovery during its capacity-free authorization preflight, then reserves Git capacity and re-enters write admission to close the race. It never invokes recovery while holding its receive reservation.
- The bounded global recovery catalog schedules work but grants no authority. Startup and every on-demand Project admission acquire the canonical Project lock, enter Project scope, and re-read the authoritative journal before recovery, isolation, or new work.
- One mixed recovery dispatcher routes catalog candidates and ordinary write-admission recovery to the activation or Accept owner. The dispatcher owns no recovery policy and never treats catalog metadata as authority.
- Reads may run concurrently only when they cannot expose a mixed authoritative snapshot. Membership changes re-evaluate queued work and event access.

## Lifecycle scope

- Implement only lifecycle operations advertised by the current milestone. Before adding creation, migration, backup, deletion, Leave, Retire, or authority handoff, record its exact durable phases, visibility, cleanup, cancellation, and recovery contract in `ARCHITECTURE.md`.
- Tests inject failure after every durable phase and prove same-Project exclusion, different-Project progress, exact replay, and fail-closed recovery.
