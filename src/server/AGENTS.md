# Server transports

## Boundary

- Transport adapters operate only after the deployment-owned trusted ingress. They bind an accepted `IngressPrincipal`, decode the canonical Cloud protocol, dispatch to owning application modules, stream responses, and map only safe errors.
- This repository does not authenticate callers or validate presented caller credentials. Do not add login, token parsing, credential lookup, refresh, revocation, or identity-provider behavior here.
- Fail closed when the trusted principal is absent, malformed, or presented through an unsupported backend path. Client bodies, query parameters, Git fields, and ordinary public headers cannot populate or override ingress identity.
- Server code never issues SQL, resolves repository paths, or invokes raw Git.

## Surface ownership

- `control/` implements the shared operation registry without a duplicate dispatch catalog.
- `git/` owns Smart HTTP streaming, disconnect detection, response settlement, and child cancellation handoff; receive-pack still enters Project mutation admission and the repository authority.
- `events/` streams durable Project invalidations. Process-local notification is only a wake-up mechanism, never event authority.
- `health/` distinguishes liveness, readiness, and version without exposing secrets, storage paths, Project existence, or recovery details.
- The implemented baseline consumes Cloud binding v1 only from exact `@claudian-collab/protocol@1.0.0`. After the producer-first Step 11 release is independently verified and this repository pins exact `2.0.0`, server transports switch as one consumer to package-owned wire v5/Cloud binding v2 route builders, streaming routes, capability and operation tokens, codecs, and limits. They never register v1 and v2 in parallel, create a compatibility shim/registry, or reinterpret v1 input as v2.
- A v2 capability is advertised only after its complete transport-to-owner path and server gate pass. The exact package pin alone advertises nothing; partial JSON or streaming work remains absent.

## Lifecycle tests

- Cover malformed input, slow and disconnected clients, response backpressure, admission closure, reconnect, and forced shutdown. Every admitted stream must have one explicit cancellation and settlement owner.
