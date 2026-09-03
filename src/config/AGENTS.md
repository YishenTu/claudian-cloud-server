# Configuration

- Decode external configuration once into typed, immutable values before
  constructing runtime owners. Reject unknown, inconsistent, or unsafe values;
  never repair them implicitly.
- Centralize resource limits, timeouts, connection budgets, repository roots,
  and runtime safety gates here. Routes and repositories must not invent local
  defaults.
- Every runtime accepts only a loopback bind. The private-development profile
  recognizes only its explicit actor assertion. The self-hosted production
  profile accepts only a complete operator-protected PROXY v2 source-to-principal
  mapping; reject partial profiles, unmapped sources, duplicate bindings, and
  every attempt to mix development and production assertions.
- Configuration selects mechanics and safe limits, not collaboration semantics.
  Self-hosted and managed profiles must not fork Project behavior.
- Secret values may be passed to narrow owners but never serialized, logged,
  included in validation errors, or exposed by health/version endpoints.
- The claim-custody keyring path is fixed at `/run/secrets/claudian_claim_custody_keyring`. Preflight accepts only a regular non-symlink file owned by UID/GID `10001:10001` with mode `0400`; failures expose one sanitized code and no path, key ID, or material.
