# Composition

- This scope owns construction, startup, readiness publication, admission closure, drain, and reverse-order disposal. It contains no Project, authorization, idempotency, recovery, or quota policy.
- Wire concrete implementations in one explicit composition root. Do not add a service locator, hidden singleton, module-level mutable registry, or import cycle to simplify assembly.
- Keep resource ownership visible: the owner that creates a server, pool, scheduler, subscription hub, or process supervisor must also close it.
- Startup validates runtime safety constraints before accepting traffic. Shutdown stops new admission before closing dependencies used by admitted work.
- Readiness remains closed until nonterminal recovery settles and every cataloged active repository passes exact Project-scoped Git integrity verification.
- Authority-transfer and retirement capabilities enter the route list as one complete lifecycle runtime. Composition never advertises either capability for a partial control, artifact, recovery, expiry, or close path.
- A lifecycle runtime reconciles recovery and due terminal responders before readiness, starts periodic expiry only after reconciliation, and closes expiry and recovery admission before its declared owner disposal order.
- Environment restore policy lives under `src/environment-maintenance/`. Composition may construct its coordinator, invoke startup recovery and readiness, and close it, but it must not interpret restore phases or register restore with Project recovery.
- Composition tests verify construction failure cleanup, startup ordering, readiness transitions, bounded shutdown, and repeated close behavior.
