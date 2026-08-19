# Configuration

- Decode external configuration once into typed, immutable values before
  constructing runtime owners. Reject unknown, inconsistent, or unsafe values;
  never repair them implicitly.
- Centralize resource limits, timeouts, connection budgets, repository roots,
  and runtime safety gates here. Routes and repositories must not invent local
  defaults.
- The current runtime accepts only a loopback bind and rejects every production
  trusted-ingress setting. Do not add a mode selector until a second real
  composition requires one; external compositions must not recognize the
  development actor assertion.
- Configuration selects mechanics and safe limits, not collaboration semantics.
  Self-hosted and managed profiles must not fork Project behavior.
- Secret values may be passed to narrow owners but never serialized, logged,
  included in validation errors, or exposed by health/version endpoints.
