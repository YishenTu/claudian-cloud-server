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
- One mixed recovery dispatcher routes catalog candidates and ordinary write-admission recovery to the exact activation, Accept, transfer, Leave, Retire, checkpoint, or deletion owner. The dispatcher owns no recovery policy, never treats catalog metadata as authority, and rejects an unknown kind with the affected Project isolated.
- Authority transfer advances the target authority generation to exactly `source + 1`. Pre-cutover cancellation must prove the target has not accepted source relinquishment; at or after the durable relinquishment boundary every recovery path is forward-only and source admission remains terminal.
- Pre-relinquishment cancellation keeps a quiesced source fenced until the exact target has durably invalidated the transfer and removed attempt-owned staging plus any inactive placement. Only that proof permits the same source generation to reopen; absence, timeout, or disconnect is never proof.
- Presence never binds another Member's target identity. LAN-to-Cloud activation may bind only the source Host through source proof; Cloud-to-LAN staging may bind only the selected target Host. Every other active Member remains imported but unbound until exact claim redemption.
- A pre-cutover claim-batch acknowledgement proves source custody only and never scrubs a claim. Per-Member scrubbing before expiry requires the same former Member to forward an exact target-signed redemption receipt through the old binding.
- One monotonic claim-batch revision is redeemable per transfer. A missing receipt first replays/queries the exact revision and digest; rotation requires authoritative proof that custody did not commit, atomically invalidates every older target hash, and replaces only uncommitted source custody. Timeout or disconnect never authorizes rotation, and a committed revision always replays the same receipt.
- Leave revokes ordinary membership admission and principal mapping atomically with one bounded former-principal replay record. That record admits only the same trusted principal and exact Leave intent/fingerprint to recover or replay the Leave result under the canonical Project lane; it never restores membership or authorizes another operation.
- Leave, Retire, authority transfer, backup, export, and deletion retain explicit operation-owned phase policy behind the shared journal mechanics. An irreversible lifecycle may hand recovery to another kind only by terminalizing the source journal and creating the target journal in one Project transaction; the dispatcher never schedules two nonterminal journals for one Project. Clean environment restore is not a Project operation and never enters this dispatcher.
- Deletion recovery remains authoritative after Project content removal through the same journal and recovery candidate in the allowlisted non-content coordination partition. Terminal responder/result, acknowledgement map, protected unclaimed claims, and the one tombstone may survive there; no Project content, ordinary admission, or second deletion registry may survive.
- Reads may run concurrently only when they cannot expose a mixed authoritative snapshot. Membership changes re-evaluate queued work and event access.

## Lifecycle scope

- Implement only lifecycle operations advertised by the current protocol capability set. `ARCHITECTURE.md` owns the accepted transfer, Leave, Retire, checkpoint, deletion, visibility, cleanup, cancellation, and recovery phase contracts; a changed phase or owner reopens architecture review before code.
- Tests inject failure after every durable phase and prove same-Project exclusion, different-Project progress, exact replay, and fail-closed recovery.
