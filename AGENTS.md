# Claudian Cloud Server

## Product boundary

- This repository owns the Cloud authority for Claudian Collab: canonical Git
  repositories, authoritative coordination state, Project authorization and
  routing, and their data lifecycles.
- Project is the membership, authorization, and managed-service eligibility
  scope. Do not introduce a separate Team entity without a new product decision.
- Endpoint reachability, entry-access policy, caller authentication, presented
  credential validation, and device credential issuance belong to the deployment
  operator's trusted ingress and, for managed deployments, the private Control
  Plane. This server consumes a trusted ingress principal; it does not implement
  or own those access and authentication mechanisms.
- Clients may select a target Project, but they cannot assert authoritative
  Account, Member, role, entitlement, service-state, or repository-placement
  values. This server derives Project membership and role from its own state,
  authorizes the operation, and resolves its routing.
- Claudian coding agents run on participant devices. The Cloud authority must
  not execute provider-backed coding-agent workloads or ingest provider
  sessions, conversations, credentials, transcripts, or private Vault state.
- Project collaboration data is limited to the explicit Project repository and
  its coordination records. Do not broaden that boundary implicitly.

## Source and deployment boundary

- Production code capable of reading or transforming Project files, diffs,
  comments, or Git objects belongs in this auditable server repository.
- Self-hosted and Claudian-managed deployments share one protocol, repository
  format, coordination model, and core server implementation. Managed-only
  systems must not become hidden dependencies of the collaboration data plane.
- Production secrets, deployment credentials, private incident procedures,
  billing configuration, and internal operational access stay outside this
  repository.

## Authority and storage invariants

- Cloud is a persistent repository authority, not a relay whose availability
  depends on a participant's LAN Host.
- Each Project has exactly one authoritative repository placement and one
  coordinated Git write path at a time. Scaling must not introduce independent
  concurrent writers for the same canonical repository.
- Repository state and coordination state have separate storage contracts and
  a deliberate cross-store recovery protocol. Never infer atomicity across
  them.
- Every admitted request is bound to a trusted ingress principal. Mutations
  crossing storage boundaries are Project-authorized, idempotent where retry is
  possible, and fail closed on stale expected state.
- Backups are not considered complete until restoration and repository
  integrity have been verified.

## Development constraints

- Keep protocol and domain semantics independent from a specific SQL engine,
  Git storage node, Cloud provider, billing system, or managed deployment.
- Treat repository content, comments, credentials, and tokens as sensitive.
  They must not appear in logs, metrics, traces, process arguments, or error
  context.
- Put local research, handoffs, traces, and throwaway scripts in `.context/`.
- Write code, comments, identifiers, commit messages, and repository documents
  in English.

## Scope map

- `src/composition/` owns construction, startup, shutdown, and dependency
  wiring; it owns no collaboration policy.
- `src/config/` owns typed configuration and deployment-profile safety.
- `src/server/` owns HTTP, Git Smart HTTP, event, health, and version transport
  adaptation after trusted ingress.
- `src/request-context/` binds the trusted ingress actor to immutable server
  request context; it does not authenticate callers or authorize Projects.
- `src/project-authority/` owns Project admission, authorization, idempotency,
  mutation ordering, lifecycle policy, and cross-store recovery.
- `src/coordination/` owns PostgreSQL schema, transaction, RLS, advisory-lock,
  connection, and persistence mechanics.
- `src/repositories/` owns placement leases, repository containment, Git
  execution, refs, quotas, and process cleanup.
- `src/onboarding/` owns isolated staging and only the onboarding profiles whose
  authority-transfer contracts have been accepted.
- `src/resource-admission/` owns global and per-Project resource permits,
  queues, reservations, and overload behavior.
- `src/observability/` owns safe telemetry and audit serialization boundaries.
- `tests/` owns cross-boundary contract, real PostgreSQL/Git integration,
  fault-injection, and staged capacity evidence.
