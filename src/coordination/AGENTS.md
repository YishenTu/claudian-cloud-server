# Coordination persistence

## Isolation and locks

- Project-owned relations and their primary/foreign keys, uniqueness constraints, and indexes preserve `project_id` locality. Globally unique IDs do not replace composite Project constraints.
- The runtime role is neither a table owner nor `BYPASSRLS`. Privileged cross-Project catalogs expose bounded scheduling metadata; work must re-enter forced-RLS Project scope.
- `ProjectLockKey` owns the single advisory-key derivation. Database-only mutations take a transaction lock; cross-store work takes the same key as a session lock on a pinned connection. Row locks follow Project admission.
- Never return a pinned connection to its pool with a session lock held. Keep ordinary transactions out of Git, network, and filesystem waits, and preserve separate ordinary, pinned, and recovery/health connection budgets.
- Development upload admission hands the pinned session from the Project lock to the exact attempt's shared fence. Settlement holds the Project lock while draining the matching exclusive fence; a process-local abort alone cannot exclude another uploader.

## Schema and durable continuity

- Initialize the absent canonical schema atomically from the checksum-pinned SQL resource. Verifying an existing current schema is read-only. A private environment-restore fence may already exist outside that schema; do not mistake it for canonical initialization.
- Journal and recovery-candidate changes commit together. Candidate and placement catalogs are bounded schedules, not alternate authorities; full facts require a journal/Project reread under its lock. Isolating an active Project removes its active-placement catalog entry atomically.
- Target claim hashes, source protected envelopes, custody receipts, and redemption receipts have distinct retention and authorization. General persistence interfaces never expose plaintext claims.
- Membership secret replay, compacted operation tombstones, and lifecycle-backed results have different retention authorities from ordinary idempotency results. Compaction preserves every retained intent identity in payload-free tombstones before removing response payloads.
- Imported claim overrides preserve accepted transfer records and terminal generation history. Responsibility-offer uniqueness and cancellation of prior-generation offers must survive concurrent role changes within one Project transaction.
- LAN-to-Cloud staging imports portable state at the target generation without an active placement, principal binding, or event. Activation may normalize a zero Manager-set generation to the first positive generation; positive imported generations remain exact.
- Former-principal replay locators and deletion continuity are not general Project query surfaces. Retain only the allowlisted journal/candidate, terminal response and acknowledgement facts, outstanding protected claims and receipt facts, and tombstone after content removal.
- Terminal response retention is independent of repository deletion progress. Responder expiry must not remove the recovery identity or require recreating a Project; terminal-continuity enumeration survives responder expiry.

## Checkpoints and restore

- Backup/export reads share one read-only repeatable-read Project snapshot. Page and byte-budget rows before client materialization; nested collections and serialized output count against the same coordination ceiling.
- Backup-only protected invitation/override frames use the coordination-owned codec. Preserve the recorded key version and reject malformed frames; never infer it from the active key or expose Cloud-only custody through portable export.
- Clean restore's private database fence binds the exact restore operation, target database authority, and publication fact. It owns no phase policy and never enters the Project recovery catalog. Only an exact unpublished fence permits canonical-state cleanup.
- Authority publication advances the database fence atomically with restored placements. Restore replaces source volume identity with target identity while preserving source identity in protected-envelope associated data.
- Schema creation and restore waits remain bounded; cancellation closes the owned connection before a later database effect can begin.
