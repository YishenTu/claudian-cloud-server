# Coordination persistence

## Storage contract

- PostgreSQL owns coordination records; Git owns objects and refs. Persistence code does not invent authorization, admission, lifecycle, idempotency, or recovery policy.
- Every Project-owned relation, primary/foreign key, uniqueness rule, and ordinary index preserves `project_id` locality. Globally unique IDs never replace composite Project constraints.
- The runtime role is separate from migration and repair roles, is not a table owner, has no `BYPASSRLS`, and remains subject to forced RLS where specified. Cross-Project enumeration returns bounded metadata and re-enters ordinary Project scope for work.

## Locking and connections

- One canonical `ProjectLockKey` implementation owns advisory-key derivation. No repository or caller hashes or casts Project IDs independently.
- Database-only mutations use a transaction-scoped advisory lock. Cross-store workflows use the same key as a session-scoped lock on one pinned connection. Row locks occur only afterward and never replace Project admission.
- A pinned connection remains checked out until the session lock is released or the connection is destroyed. It must never return to the pool while holding a lock.
- Keep ordinary transactions short and never hold one across Git, network, backup-copy, or filesystem work. Preserve explicit ordinary, pinned-lease, and recovery/health connection budgets.

## Migration and recovery enumeration

- Steps 5–8 add checksum-verified migrations in one serial lane: `0002_development_bootstrap.sql`, `0003_project_read_events.sql`, `0004_collaboration.sql`, then `0005_accept_recovery.sql`. Each migration change owns its registry entry, grants, forced-RLS policy, and real PostgreSQL evidence.
- The recovery-candidate catalog contains only operation kind, opaque Project/operation identity, and scheduling timestamps. Enumerate at most 100 rows per stable keyset page; full journals are readable only after re-entering exact forced-RLS Project scope under the canonical Project lock.
- A nonterminal activation or Accept journal updates its candidate in the same transaction. Terminal completion or cancellation removes it. Enumeration is idempotent scheduling and never substitutes for the on-demand journal check.

## Verification

- Use real PostgreSQL for migrations, grants, RLS, advisory-lock interaction, pool exhaustion, process-death release, statement/lock timeouts, and same-Project versus different-Project concurrency tests.
