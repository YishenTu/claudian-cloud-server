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
- Production code does not use `console.*`. Route runtime output through the
  safe logger and allowlisted serializers. Startup failures before logger
  construction use one explicit sanitized bootstrap reporter.
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

## AGENTS.md maintenance

- Treat instruction files as execution context, not general documentation.
  Keep only current constraints that materially change implementation, review,
  or verification behavior; use version control as the history.
- Before changing a scoped area, read the root-to-scope instruction chain. Keep
  repository-wide rules and the scope map here, and place ownership,
  dependency, lifecycle, failure, and verification rules in the narrowest
  governing scope.
- Do not duplicate inherited rules or silently contradict them. State a
  necessary scoped exception and its rationale explicitly.
- Record an architecture decision only when it is active, non-obvious,
  expensive to reverse, and based on an accepted tradeoff. Update the governing
  instruction before implementation establishes a new ownership boundary.
- Every `AGENTS.md` has a sibling `CLAUDE.md` whose entire content is exactly
  `@AGENTS.md`.

## Naming conventions

- Interfaces do not use an `I` prefix. Treat acronyms as words in Claudian-owned
  symbols, such as `ProjectId`, `GitOid`, and `RequestDto`; preserve an external
  protocol or library spelling only when mirroring that contract exactly.
- Name a TypeScript file after its primary exported concept in `PascalCase.ts`.
  Use `camelCase.ts` for a utility collection with no dominant export, and use
  `kebab-case` for directories.
- Tests mirror the target concept with a `.test.ts` suffix. Keep `index.ts`
  barrels only at deliberate stable export boundaries; do not create broad
  convenience barrels.

## TDD workflow

### General

- Production behavior changes and bug fixes must use TDD: establish a failing
  executable test at an agreed seam before implementation. Documentation-only
  and non-behavioral mechanical changes are exempt. When an automated failing
  test is not feasible, record repeatable failing evidence first and cover the
  closest stable seam.
- Treat documented owning-module and public interfaces as pre-agreed test
  seams. If behavior cannot be verified without reaching past a seam, resolve
  the ownership or interface decision before writing the test; do not add a
  test-only facade or public method.
- Build vertical tracer bullets: exercise one observable behavior at one seam
  with the minimum implementation needed to prove it. Do not batch a horizontal
  layer of tests around imagined types, collaborators, or future behavior.
- Derive expected results independently from the implementation, using a
  specification literal, accepted fixture, or worked example. Do not reproduce
  the production algorithm in the assertion, assert internal call counts, or
  bypass the owning interface to inspect storage unless that storage contract
  is the declared seam under test.
- Mock only true external boundaries, through narrow operation-specific ports
  rather than a generic conditional transport. Keep owned modules real.
- After a tracer bullet is green, review and refactor its structure separately
  under the passing seam-level tests. Do not mix speculative architecture work
  into the behavior cycle.

### Project-specific

- Application behavior enters through the owning interfaces in the scope map,
  especially `ProjectAuthority`, `GitRepositoryAuthority`, request context, and
  resource admission. Direct PostgreSQL or Git inspection is reserved for the
  integration lanes where that dependency contract is the declared seam.
- Canonical Cloud protocol fixtures and worked Git/SQL examples are independent
  sources of expected behavior.
- Follow `tests/AGENTS.md` for evidence boundaries: real PostgreSQL, real Git,
  and real process behavior establish isolation, locking, ref, sandbox,
  cleanup, and recovery correctness.
- Cross-store and lifecycle work injects failure after every documented durable
  phase and proves exact completion, permitted cleanup, idempotent replay, or
  fail-closed recovery.

## Review checks

- Report findings first, ordered by correctness, security and data isolation,
  contract compatibility, regression risk, and maintainability.
- Enforce the ownership and dependency boundaries in this instruction chain.
  Shared wire changes preserve the canonical protocol package as the only
  contract owner; server code does not create a parallel operation registry or
  compatibility policy.
- Mutation reviews verify Project authorization, the one Project write lane,
  idempotency, expected state, durable recovery, and bounded resource cleanup.
  PostgreSQL/Git reviews never infer cross-store atomicity.
- If no material finding remains, say so and report residual risks or evidence
  gaps.
