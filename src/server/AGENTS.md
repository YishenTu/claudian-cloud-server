# Server transports

## Boundary

- Transport adapters operate only after the deployment-owned trusted ingress. They bind an accepted `IngressPrincipal`, decode the canonical Cloud protocol, dispatch to owning application modules, stream responses, and map only safe errors.
- This repository does not authenticate callers or validate presented caller credentials. Do not add login, token parsing, credential lookup, refresh, revocation, or identity-provider behavior here.
- Fail closed when the trusted principal is absent, malformed, or presented through an unsupported backend path. Client bodies, query parameters, Git fields, and ordinary public headers cannot populate or override ingress identity.
- In the self-hosted production profile, the loopback listener may consume one bounded PROXY protocol v2 frame from the operator-owned TCP ingress and attach only its exact allowlisted source-to-principal assertion to the accepted socket. Raw HTTP, ordinary forwarded headers, unmapped sources, malformed frames, and a second frame never establish identity; public health and capability routes remain principal-free.
- Server code never issues SQL, resolves repository paths, or invokes raw Git.

## Surface ownership

- `control/` implements the shared operation registry without a duplicate dispatch catalog.
- Cloud Project membership control dispatches creation, invitations, Join, imported-claim administration, member listing, Manager responsibility, Removal, and Leave only to their owning authorities. It does not inspect claim digests, offer state, membership role, principal binding, lifecycle phase, or expected-generation policy.
- `git/` owns Smart HTTP streaming, disconnect detection, response settlement, and child cancellation handoff; receive-pack still enters Project mutation admission and the repository authority.
- `events/` streams durable Project invalidations. Process-local notification is only a wake-up mechanism, never event authority.
- `transfer/` owns bounded authority-transfer artifact streaming after trusted ingress. Rejected incomplete uploads close their connection, and every acquired or late-arriving download stream is deterministically destroyed when transport cannot consume it. This scope never interprets checkpoint contents, derives lifecycle phase, or invents digest headers outside the package binding.
- `health/` distinguishes liveness, readiness, and version without exposing secrets, storage paths, Project existence, or recovery details.
- The server consumes package-owned wire v8 and Cloud binding v4 only from exact `@claudian-collab/protocol@4.1.3`. It never registers previous bindings in parallel, creates a compatibility shim/registry, or reinterprets old input as current input.
- A v4 capability is advertised only after its complete transport-to-owner path and server gate pass. The exact package pin alone advertises nothing; partial JSON or streaming work remains absent.
- LAN-source-only proposal and Host-acceptance operations remain on the dedicated LAN binding. The Cloud v4 router must not register them or infer a source direction through fallback mutation attempts.

## Lifecycle tests

- Cover malformed input, slow and disconnected clients, response backpressure, admission closure, reconnect, and forced shutdown. Every admitted stream must have one explicit cancellation and settlement owner.
