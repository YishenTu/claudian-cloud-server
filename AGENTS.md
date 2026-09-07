# Claudian Cloud Server

## Product and source boundaries

- This repository owns persistent canonical Project repositories, coordination state, Project authorization, routing, and data lifecycles. Its availability must not depend on a participant's LAN Host.
- Project is the membership, authorization, and managed-service eligibility scope. Do not introduce a separate Team entity without a product decision.
- The operator owns connection-access authentication, TLS or encrypted tunneling, and unchanged traffic forwarding. The server listens only on loopback, verifies the client-held Claudian Vault credential, and derives its principal; it implements no ingress, Account login, or operator access policy.
- Clients select a Project; the server derives membership, role, service state, and repository placement. Client assertions cannot establish those authorities.
- Coding agents run on participant devices. The server handles only the explicit Project repository and coordination records; it must not execute provider-backed coding agents or ingest provider sessions, conversations, credentials, transcripts, or private Vault state.
- The standalone `@claudian-collab/protocol` repository owns shared wire contracts, validators, compatibility, and releases. Consume an exact registry version; do not vendor its source or create a parallel operation inventory or compatibility layer.
- Code that reads or transforms collaboration content belongs in this auditable repository. Self-hosted and managed deployments share the same core implementation; private managed systems must not become hidden data-plane dependencies. Production secrets and operator-specific access, billing, and incident configuration stay outside the repository.

## Authority invariants

- Each Project has one authoritative repository placement and one coordinated Git write path. PostgreSQL and Git are separate stores; mutations need explicit recovery and must not assume cross-store atomicity.
- Authority transfer preserves exactly one writable generation. Reopening a quiesced source requires target proof before relinquishment; after the durable relinquishment fence, recovery is forward-only to the target.
- Operator access never authorizes Project deletion. Maintenance may resume only an exact deletion journal created by Project-authorized Retire or authority handoff.
- Database initialization creates only an absent canonical schema. Runtime and maintenance require the exact current schema; no in-place schema transition or implicit adoption of existing state is supported.

## Ownership

- `src/composition/`: construction, startup, shutdown, and dependency wiring; no collaboration policy.
- `src/config/`: external configuration decoding and runtime safety constraints.
- `src/server/`: HTTP, Git Smart HTTP, events, health, and capability discovery.
- `src/request-context/`: Vault credential verification and immutable request identity; no Project authorization.
- `src/project-authority/`: Project admission, authorization, idempotency, mutation ordering, lifecycle policy, and cross-store recovery.
- `src/environment-maintenance/`: environment-wide offline policy and maintenance command adaptation; no authority to create Project mutations.
- `src/coordination/`: PostgreSQL schema, transactions, RLS, locks, connections, and persistence mechanics.
- `src/repositories/`: placement validation, repository containment, Git execution, refs, quotas, and process cleanup.
- `src/onboarding/`: isolated staging and validation; no canonical Project activation authority.
- `src/resource-admission/`: shared resource permits, queues, reservations, and overload behavior.
- `src/observability/`: safe runtime output and telemetry serialization.
- `deploy/`: shared container artifacts and single-host deployment mechanics.
- `tests/`: cross-boundary contracts, real-dependency integration, fault injection, and capacity evidence.

## Development conventions

- Repository content, comments, credentials, and tokens must not appear in logs, metrics, traces, process arguments, or error context. Production runtime output uses the safe logger and allowlisted serializers; pre-logger startup failures use the sanitized bootstrap reporter. Production code does not use `console.*`.
- Put local research, handoffs, traces, and throwaway scripts in `.context/`.
- Write code, comments, identifiers, commits, and repository documents in English. Keep Markdown soft-wrapped.
- Interfaces have no `I` prefix. Treat acronyms as words in owned symbols (`ProjectId`, `GitOid`); preserve external spellings when mirroring an external contract.
- TypeScript files use their primary exported concept's `PascalCase` name, or `camelCase` for utility collections. Directories use `kebab-case`; tests use `.test.ts`. Barrels belong only at deliberate stable export boundaries.

## Verification

- Production behavior changes and bug fixes use TDD: establish a failing executable test before implementation. Documentation and non-behavioral mechanical changes are exempt. If automation is infeasible, record repeatable failing evidence and cover the closest stable interface.
- Existing owning-module and public interfaces are accepted test seams. Do not add test-only public APIs or replace owned modules with mocks to bypass those boundaries. Mock external dependencies through operation-specific ports.
- Expected results come from protocol fixtures, specification literals, or worked examples, not a copy of the production algorithm. See `tests/AGENTS.md` for real-dependency and recovery evidence requirements.
- Do not test statically defined values whose correctness is already established by their source or type declaration. Test the observable behavior that consumes them only when that behavior has meaningful regression risk.
- When logic is deleted, do not add negative tests that merely prove the removed path no longer exists. Cover only the observable replacement behavior or contract that could realistically regress.
- Reviews report material findings first, then residual risks or evidence gaps. State when no material finding remains.

## Instruction maintenance

- Read the root-to-scope instruction chain before editing. Keep each constraint in one authoritative scope; state necessary exceptions explicitly.
- Retain only current, non-obvious constraints that change implementation or verification decisions. Do not turn instruction files into implementation inventories, task histories, or plans.
- Every `AGENTS.md` has a sibling `CLAUDE.md` containing only `@AGENTS.md`.
