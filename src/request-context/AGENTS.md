# Request context

## Authority boundary

- This scope accepts caller identity already established by a deployment-owned trusted ingress and constructs an immutable `IngressPrincipal`. It does not authenticate callers, validate their credentials, or own credential expiry and revocation.
- `IngressPrincipal` is a server-side deployment contract, not a Cloud protocol DTO. Never derive it from client JSON, query parameters, Git fields, source IP, or an unprotected pass-through header.
- The production adapter must rely on an ingress-to-backend channel whose identity integrity and direct-access prevention are deployment guarantees. Validate the principal shape and provenance expected by that adapter, then discard transport-specific assertion details.
- `TrustedPrincipalProvider` accepts only an already-established strict assertion containing a stable `principalId`, optional opaque `deviceCredentialId`, and `operator-protected-channel` provenance with an opaque provider ID. Provenance is attribution, not caller credential proof; unknown identity, role, membership, request, header, address, or socket fields fail closed.
- The principal carries a stable opaque actor or Account identity and the attribution required by its deployment profile. Managed ingress requires a stable device-credential ID; self-hosted ingress may omit device identity when its accepted contract has no device concept. It never carries Project membership, role, eligibility, service state, or repository placement.
- Project admission derives membership and authorization from server-owned state. Keep that policy in `project-authority`, not here.

## Profiles and tests

- Keep the private-development actor assertion in a separately named adapter that cannot be composed into an external profile.
- One application composition selects exactly one request principal binding. That binding serves every Project JSON, Git, event, lifecycle, and artifact transport; never mix private-development headers with an injected production provider in one process.
- The private-development adapter emits the same `principalId` shape with `private-development` provenance. It retains no `actorId` alias and no production provider accepts its header, address, or provenance shape.
- Before Project activation, that adapter may bind the asserted actor only to the matching immutable bootstrap manifest/report under the accepted two-client exception. It never accepts asserted role, service state, placement, Host status, or another Member's report; after activation, ordinary Project authority derives membership and role from Cloud state.
- Contract tests prove that client-controlled fields cannot override accepted actor or device attribution and that missing or malformed ingress context fails closed without logging assertion material.
