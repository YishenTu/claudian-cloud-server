# Verification

## Test ownership

- `contract/` proves the one shared Cloud protocol registry, codecs, compatibility behavior, safe errors, and trusted-principal binding.
- `integration/postgres/` uses real PostgreSQL for migrations, grants, RLS, advisory locks, pool budgets, idempotency, events, and concurrency.
- `integration/git/` uses real Git and bare repositories for Smart HTTP, refs, placement generations, path containment, quotas, sandboxing, and process lifecycle.
- `fault-injection/` kills work after every documented durable phase and proves exact completion, idempotent replay, permitted staging cleanup, or `recovery-required` isolation.
- `capacity/` exercises the staged workloads and provisional limits in `ARCHITECTURE.md`; results revise configuration and do not silently become product commitments.

## Evidence rules

- Do not replace PostgreSQL advisory-lock/RLS behavior or Git ref/process behavior with mocks when the real dependency is what establishes safety.
- Every multi-Project isolation test uses overlapping display names, Ticket numbers, Member names, and unrelated IDs to expose missing scope predicates.
- Tests involving logs, errors, process arguments, or metrics assert sensitive data absence.
- Timeouts, disconnects, restart, and forced process death must prove cleanup and recovery; a missing response or file is never treated as completion.
