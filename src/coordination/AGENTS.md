# Coordination persistence

## Storage contract

- PostgreSQL owns coordination records; Git owns objects and refs. Persistence code does not invent authorization, admission, lifecycle, idempotency, or recovery policy.
- Every Project-owned relation, primary/foreign key, uniqueness rule, and ordinary index preserves `project_id` locality. Globally unique IDs never replace composite Project constraints.
- The runtime role is separate from migration and repair roles, is not a table owner, has no `BYPASSRLS`, and remains subject to forced RLS where specified. Cross-Project enumeration returns bounded metadata and re-enters ordinary Project scope for work.

## Locking and connections

- One canonical `ProjectLockKey` implementation owns advisory-key derivation. No repository or caller hashes or casts Project IDs independently.
- Database-only mutations use a transaction-scoped advisory lock. Cross-store workflows use the same key as a session-scoped lock on one pinned connection. Row locks occur only afterward and never replace Project admission.
- A pinned connection remains checked out until the session lock is released or the connection is destroyed. It must never return to the pool while holding a lock.
- A development upload admitted under the Project lock atomically hands the pinned session to an attempt-scoped shared advisory lock. Settlement holds the Project lock while acquiring the matching exclusive lock, so no process can begin or outlive publication or staging cleanup.
- Keep ordinary transactions short and never hold one across Git, network, backup-copy, or filesystem work. Preserve explicit ordinary, pinned-lease, and recovery/health connection budgets.

## Migration and recovery enumeration

- The checksum-verified serial lane is `0002_development_bootstrap.sql`, `0003_project_read_events.sql`, `0004_collaboration.sql`, `0005_accept_recovery.sql`, then `0006_portability_lifecycle.sql`. Each migration change owns its registry entry, grants, forced-RLS policy, and real PostgreSQL evidence.
- The recovery-candidate catalog contains only operation kind, opaque Project/operation identity, and scheduling timestamps. Enumerate at most 100 rows per stable keyset page; full journals are readable only after re-entering exact forced-RLS Project scope under the canonical Project lock.
- The active-placement catalog contains only the placement lease needed to schedule startup integrity checks. Classifying an activated Project as `recovery-required` removes its catalog entry in the same transaction so one isolated Project cannot fail global startup integrity enumeration. Enumerate at most 100 rows per stable Project-ID page, then re-enter forced-RLS Project scope under the canonical Project lock for Project, membership, and current-placement facts.
- Every nonterminal Project lifecycle journal updates its candidate in the same transaction. Terminal completion or cancellation removes it. Enumeration is idempotent scheduling and never substitutes for the on-demand journal check.
- Target claim hashes and source-retained protected claim envelopes are distinct records. Batch custody and per-Member redemption receipts have separate constraints; batch acknowledgement cannot alter redemption or retention state. Plaintext claims are never persisted or returned by general persistence interfaces.
- Leave persists ordinary membership/principal revocation and its exact former-principal replay locator in one transaction. General Project queries cannot read that locator; the Leave owner may resolve only exact principal, Project, Member, intent, and fingerprint for bounded recovery/replay.
- Backup logical export includes only the accepted profile's operational continuity. Environment restore imports through narrow storage ports but its global journal and phase policy remain outside coordination and outside the Project recovery catalog.
- Deletion preserves one allowlisted non-content partition after Project-content removal: the existing deletion journal/candidate, terminal responder/result, former-principal acknowledgement map, protected unclaimed claim envelopes and receipt-key facts where applicable, and one tombstone. These rows retain the same Project ID, forced-RLS context, phase CAS, and dispatcher; they are not a second catalog and cannot satisfy ordinary Project admission.

## Verification

- Use real PostgreSQL for migrations, grants, RLS, advisory-lock interaction, pool exhaustion, process-death release, statement/lock timeouts, and same-Project versus different-Project concurrency tests.
