# Verification

## Evidence boundaries

- Consumer contract tests verify compatibility with the exact protocol package. Shared codec/registry tests belong to the protocol repository; do not recreate its contract owner here. Vault credential binding belongs to request-context and real HTTP tests.
- Use real PostgreSQL for schema initialization, grants, RLS, advisory locks, pool exhaustion, transaction isolation, and process-death lock release. Use real Git/processes for refs, placement, containment, quotas, corruption, stream settlement, cancellation, and child cleanup.
- Exercise application behavior through its owning interface. Direct SQL/Git inspection is appropriate when the storage or process contract itself is the seam under test.
- Isolation evidence must include concurrent same-Project exclusion and different-Project progress. Use colliding human-readable labels where relevant; globally unique test IDs alone do not expose missing scope predicates.
- Capture affected logging/error/process sinks and assert sensitive data is absent. A timeout, disconnected response, or missing file does not establish completed cleanup or settlement.
- Capacity results describe measured workloads and configured limits, not product guarantees. A service container or controlled child environment is not evidence of per-Project sandbox isolation.

## Recovery evidence

- Cross-store and lifecycle changes inject failure after each affected durable phase. Prove exact replay, permitted owned cleanup, forward recovery after the irreversible fence, or isolation at the correct Project/environment scope, including restart by another process.
- Membership tests preserve invisibility before activation, invitation capacity reservations, single redemption, exact personal-ref CAS, monotonic claim/role revisions, and final-Manager succession. Revoked principals may replay only their exact retained result, never regain ordinary admission.
- Transfer tests prove one writable generation, target-proof cancellation, exact claim-batch replay, rotation only after authoritative non-retention proof, and no scrubbing from custody acknowledgement. Terminal status/claim access must not authorize target-only activation replay.
- Deletion tests kill work immediately after coordination-content removal and recover through the surviving journal under the same Project lock. Verify retained terminal claims/replay without recreating ordinary content or admission, and reject maintenance that lacks the original authorized journal identity/digest.
- Backup/restore tests use multi-Project real stores, including terminal-only Projects, keyring mismatch, database/volume ambiguity, and failure before/after publication. Verify exact refs/OIDs and claim redemption continuity after restore; backups contain neither plaintext claims nor private keys.
- Deployment changes verify the rendered Compose model and affected privilege/mount boundaries. Image or process-lifecycle changes also exercise real container readiness and bounded SIGTERM shutdown.
