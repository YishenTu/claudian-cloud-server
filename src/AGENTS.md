# Application source

## Architecture contract

- Keep one modular-monolith composition root. Modules communicate through explicit domain contracts and do not reach through another module to its storage or transport implementation.
- Dependency direction is transport and infrastructure toward `project-authority`; domain policy never imports HTTP, PostgreSQL, or process implementations.
- The shared Cloud protocol package is the only wire-contract owner. Do not create a second operation inventory, compatibility policy, or validator map.
- Keep Project, membership, coordination, repository placement, and recovery semantics independent from deployment profile and provider products.

## Lifecycle

- The composition root owns start, readiness, admission close, drain, forced cancellation, and disposal order for every process-owned resource.
- A client disconnect or process shutdown is not proof that a mutation failed. Preserve durable recovery and idempotency identity after ambiguous progress.
- Do not create modules, protocol operations, or durable phase names for a deferred lifecycle feature until its decision-complete contract enters the implementation sequence.

## Verification

- Test through owning module interfaces. Use real PostgreSQL and real Git for isolation, locking, ref, process, and recovery behavior that substitutes cannot prove.
