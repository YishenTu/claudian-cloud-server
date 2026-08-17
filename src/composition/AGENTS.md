# Composition

- This scope owns construction, startup, readiness publication, admission
  closure, drain, and reverse-order disposal. It contains no Project,
  authorization, idempotency, recovery, or quota policy.
- Wire concrete implementations in one explicit composition root. Do not add a
  service locator, hidden singleton, module-level mutable registry, or import
  cycle to simplify assembly.
- Keep resource ownership visible: the owner that creates a server, pool,
  scheduler, subscription hub, or process supervisor must also close it.
- Startup validates deployment-profile constraints before accepting traffic.
  Shutdown stops new admission before closing dependencies used by admitted
  work.
- Composition tests verify construction failure cleanup, startup ordering,
  readiness transitions, bounded shutdown, and repeated close behavior.
