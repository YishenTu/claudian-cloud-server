# Server transports

## Boundary

- Transport adapters operate only after the deployment-owned trusted ingress.
  They bind an accepted `IngressPrincipal`, decode the canonical Cloud protocol,
  dispatch to owning application modules, stream responses, and map only safe
  errors.
- This repository does not authenticate callers or validate presented caller
  credentials. Do not add login, token parsing, credential lookup, refresh,
  revocation, or identity-provider behavior here.
- Fail closed when the trusted principal is absent, malformed, or presented
  through an unsupported backend path. Client bodies, query parameters, Git
  fields, and ordinary public headers cannot populate or override ingress
  identity.
- Server code never issues SQL, resolves repository paths, or invokes raw Git.

## Surface ownership

- `control/` implements the shared operation registry without a duplicate
  dispatch catalog.
- `git/` owns Smart HTTP streaming, disconnect detection, response settlement,
  and child cancellation handoff; receive-pack still enters Project mutation
  admission and the repository authority.
- `events/` streams durable Project invalidations. Process-local notification is
  only a wake-up mechanism, never event authority.
- `health/` distinguishes liveness, readiness, and version without exposing
  secrets, storage paths, Project existence, or recovery details.

## Lifecycle tests

- Cover malformed input, slow and disconnected clients, response backpressure,
  admission closure, reconnect, and forced shutdown. Every admitted stream must
  have one explicit cancellation and settlement owner.
