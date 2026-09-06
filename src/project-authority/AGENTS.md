# Project authority

## Admission and mutation ordering

- Business idempotency belongs to Project membership and exact operation intent; device or session attribution does not create a separate business actor.
- Resolve or isolate nonterminal cross-store work before admitting a new Project mutation. Revalidate authorization, expected revisions/OIDs, and placement at the last boundary before irreversible effects; reads must not expose mixed authoritative state.
- For Git-backed mutations, reserve Project-scoped Git capacity before acquiring the canonical Project lease and retain that reservation through settlement. Backup/export also reserves coordination heap capacity before the lease. Acquiring capacity from inside the lease can deadlock against receive-pack.
- Publish and receive-pack perform recovery before reserving Git capacity, then recheck under write admission. If a new recovery obligation appears, release capacity and retry; do not invoke recovery while holding a reservation needed by recovery itself.
- A recovery dispatcher performs a capacity-free journal preflight, obtains the owning lifecycle's reservation, then re-enters the Project lane and rereads the journal. Catalog metadata schedules work; it never authorizes effects or selects a phase policy.
- Emit `ProjectMutationRejection` only after checking exact retained results, tombstones, and nonterminal journals under the Project lane. Durable terminal invitation facts or strictly advanced expected revisions can prove rejection; absent rows, future expectations, mutable authorization, and stale prepared state cannot. Imported-claim generation alone is insufficient because it can restart on another import.

## Membership and visibility

- Creation and Join become forward-only once their exact plans are prepared. Partial repositories or refs must be verified against those plans, never deleted as a cancellation shortcut. Creation remains invisible until activation; nonterminal Join fences ordinary reads and writes.
- Invitation reservations count toward membership capacity before redemption. Ordinary invitations and imported-member claims remain separate authorities, including their secret custody, replay, expiry, and tombstones.
- Imported-claim overrides cannot rewrite an accepted transfer batch or reuse terminal authority. Redemption resolves the highest recorded override history; revocation or expiry must not revive an earlier digest. Imported Members remain unbound until the authorized claim or source/target proof binds them.
- Enforce expiry from immutable timestamps in the owning transaction. Background reconciliation cleans up expired state but cannot extend eligibility or replay deadlines.
- Manager responsibility uses durable offers and expected membership/manager-set revisions, with no presence prerequisite. Preserve at least one active Manager; the last Manager may Leave only through the exact acknowledged succession offer.
- Removal and Leave persist the exact personal-ref OID before membership effects. Binding/claim revocation, offers, owned open work, structured mentions, succession, and the immutable result settle together; Git deletion then uses that persisted OID and recovers forward.
- Former-member replay authorizes only the same principal and exact settled operation intent/fingerprint. It never restores ordinary membership or authorizes another operation.

## Lifecycle recovery

- A cross-store journal records the deterministic pre-effect plan and possible versus confirmed progress. A missing file, disconnect, or lost response is never proof of success or safe cancellation.
- Accept persists its deterministic commit plan before Git effects and its verified result OID before protected-main CAS. Cancellation cannot take over after preparation.
- Development activation owns publication and cancellation settlement. After publication intent, cancellation cannot take ownership. Before publishing or deleting staging, persist settlement intent, close/abort local uploads, and drain the exact cross-process upload fence.
- Direction-specific transfer owners authorize status and cancellation under the Project lane. Dispatchers do not probe mutations or infer direction from caller assertions; unknown transfers and unrelated principals remain indistinguishable.
- Target authority generation is exactly source generation plus one. Pre-relinquishment cancellation requires durable target invalidation and cleanup proof before reopening the source. Timeouts or missing target state are not proof.
- After source relinquishment, LAN-to-Cloud recovery must use retained verified proof and local staging; it cannot depend on contacting the relinquished source again.
- A lifecycle waiting for external proof remains fenced and cataloged. Startup may continue past that declared waiting state, but ordinary Project admission remains blocked; unknown or contradictory recovery is not external waiting.
- Presence cannot bind another Member's target identity. Only the source Host or selected target Host is bound by its direction's proof; all other imported Members require their own claim redemption.
- Claim-batch custody acknowledgement does not authorize per-Member scrubbing. Before expiry, scrubbing requires the same former Member to forward the exact target-signed redemption receipt.
- At most one claim-batch revision is redeemable. Missing receipts trigger exact replay/query; rotation requires authoritative proof that custody did not commit and atomically invalidates older hashes. Committed custody always replays its original receipt.
- Transfer expiry is derived once in the first-create transaction and preserved on replay. Composition, transport, and retries cannot replace its retention policy.
- Backup/export recovery uses immutable journal-owned staging and deadlines, not current build metadata or a restarted timer. Before publication, timeout permits exact owned cleanup; after publication, verification and completion are forward-only. Export delivery cleanup is separate from immutable backup retention.
- Lifecycle handoff terminalizes the source journal and creates the target journal in one Project transaction. Never schedule two nonterminal lifecycle owners for one Project.
- Deletion retains only the coordination-owned non-content continuity partition under the same Project identity and recovery catalog. That partition supports exact terminal replay and outstanding claims, never ordinary content or admission. Target-only activation replay remains distinct from former-member status/claim access.
