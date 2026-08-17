# Resource admission

- This scope is the single owner of global and per-Project queues, Git-child
  permits, streamed-byte and disk reservations, connection/request caps, and
  overload decisions. Domain modules request permits; routes and repositories
  do not maintain independent counters.
- Keep limits in validated configuration and expose their current effective
  values through safe operational metrics. Architecture capacity values are
  provisional test defaults, not promises.
- One Project cannot consume every Git child, queue slot, pinned connection,
  staging byte, or disk reserve. Preserve separate read/write limits and the
  one-mutation Project lane.
- Acquisition has a bounded deadline and a retryable busy result. Every permit
  and reservation has one cleanup owner and releases on rejection,
  cancellation, child exit, timeout, shutdown, and recovery failure.
- Recovery and health retain reserved capacity when ordinary request traffic is
  saturated. Background backup and maintenance consume the same real resource
  budgets as foreground work.
- Tests saturate every limit, cancel at each handoff, and prove unrelated
  Projects progress without leaks or negative/double-released accounting.
