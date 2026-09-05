# Verification

## Test ownership

- `contract/` proves the one shared Cloud protocol registry, codecs, compatibility behavior, safe errors, and trusted-principal binding.
- `integration/postgres/` uses real PostgreSQL for current-schema initialization, grants, RLS, advisory locks, pool budgets, idempotency, events, and concurrency.
- `integration/git/` uses real Git and bare repositories for Smart HTTP, refs, placement generations, path containment, quotas, sandboxing, and process lifecycle.
- `fault-injection/` kills work after every documented durable phase and proves exact completion, idempotent replay, permitted staging cleanup, or `recovery-required` isolation.
- `capacity/` exercises the staged workloads and provisional limits in `ARCHITECTURE.md`; results revise configuration and do not silently become product commitments.
- Steps 5–8 advance through `G5`, `G6R`, `G6W`, `G7`, `G8A`, and `GI`. A changed contract, durable phase, owner, or advertised capability reopens its gate and every dependent gate.
- Step 11 fault injection covers both authority-transfer directions, Leave settlement, Retire/deletion, backup, and environment restore after every documented durable phase. Recovery must finish the exact operation, return its idempotent result, clean only phase-permitted owned staging, recover forward after relinquishment/publication, or isolate the correct Project/environment.
- Claim-custody fault tests lose and reorder batch delivery, acknowledgement, and receipt around target staging. They prove exact committed-revision replay, rotation only after authoritative not-retained proof, atomic invalidation of every older target hash, stale delayed-message rejection, and at most one redeemable batch.
- Leave fault injection proves a lost response after membership revocation remains recoverable only by the same accepted former principal and exact intent/fingerprint; unrelated principals, changed requests, and all ordinary Project operations remain denied.

## Evidence rules

- Do not replace PostgreSQL advisory-lock/RLS behavior or Git ref/process behavior with mocks when the real dependency is what establishes safety.
- Every multi-Project isolation test uses overlapping display names, Ticket numbers, Member names, and unrelated IDs to expose missing scope predicates.
- Tests involving logs, errors, process arguments, or metrics assert sensitive data absence.
- Timeouts, disconnects, restart, and forced process death must prove cleanup and recovery; a missing response or file is never treated as completion.
- Protected-claim recovery proves backup contains no plaintext/private key, missing or wrong keyring fails before restore publication, and a restored former Member can retrieve and redeem the exact claim, replay the signed receipt, and scrub only its source envelope.
- Deletion fault injection kills immediately after coordination removal and proves the same surviving journal/candidate resumes under the canonical Project lock, exact former-principal terminal replay and protected claims still work, `resume-delete` requires the original authorized identity/digest, and no ordinary content or admission is recreated.
