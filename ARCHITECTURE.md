# Claudian Cloud Server Architecture

Claudian Cloud Server is a persistent collaboration authority. It stores canonical Project Git repositories and coordination records independently of participant devices. Coding agents, provider sessions, private conversations, working copies, and unpublished local drafts remain on those devices.

This document describes the server implementation and its operational boundaries. Installation and configuration are in [README.md](README.md); contributor constraints are in [AGENTS.md](AGENTS.md).

## Deployment and trust boundary

The deployment consists of one Node.js service, PostgreSQL, and a persistent authority volume. A Project is the membership, authorization, repository-placement, and lifecycle scope. Projects share the service and database; the server does not allocate a VM or persistent container per Project.

```text
Claudian client
  | Cloud protocol, Git Smart HTTP, events, and artifact streams
  v
Operator-owned authenticated entry point
  | TLS or encrypted tunnel; unchanged forwarding
  v
127.0.0.1:<configured port>
  | Vault credential verification
  | Project membership and operation authorization
  +--> PostgreSQL coordination state
  +--> canonical bare Git repositories
```

The operator provides endpoint reachability, connection-access authentication, and transport encryption. The server implements none of those entry-point services. Forwarding preserves the client's Authorization header, WebSocket upgrades, and streamed request/response bodies.

The server accepts exactly one `Authorization: Bearer <credential>` header for each Project request or WebSocket handshake. The client generates a 32-byte random credential, represents it as 64 lowercase hexadecimal characters, and synchronizes it in the Vault. The principal is `vault-` followed by the lowercase SHA-256 hex digest of the credential's UTF-8 text. The binding is per request, including when a TCP connection is reused.

The server stores derived principal bindings rather than raw Vault credentials. Client-supplied principal IDs, roles, device metadata, and socket addresses cannot establish Project authority. A valid new credential establishes only its own identity; creating a Project, joining by invitation, and redeeming an imported membership claim have separate admission policies.

Self-hosted and managed installations use the same runtime and protocol. Account login, billing, and entitlement systems are outside this repository; the current server has no Account-entitlement projection or billing-driven admission path.

The explicit `private-development` profile uses a development actor assertion and an isolated two-Member bootstrap contract. It is a testing interface, not the release installation profile. Release configuration selects `vault-credential`.

## Runtime ownership

| Module | Responsibility |
| --- | --- |
| `composition` | Construct owners, reconcile startup, publish readiness, close admission, and dispose resources. |
| `config` | Decode external settings and validate keyring/runtime constraints. |
| `request-context` | Verify the Vault credential and produce immutable caller identity. |
| `server` | Adapt protocol JSON, Git Smart HTTP, events, health, and artifact streams. |
| `project-authority` | Authorize Project operations and own idempotency, ordering, lifecycle, and recovery policy. |
| `coordination` | Implement PostgreSQL persistence, transactions, RLS, catalogs, and locks. |
| `repositories` | Validate placements and paths, execute Git, enforce refs/quotas, and manage repository publication/removal. |
| `onboarding` | Receive and validate isolated artifacts without activating Project authority. |
| `resource-admission` | Bound shared Git, upload, staging, and event resources. |
| `environment-maintenance` | Coordinate environment backup/restore and adapt offline maintenance commands. |
| `observability` | Emit allowlisted runtime output without collaboration content or secrets. |

Transport and storage implementations do not take over Project policy. Cross-module operations use the owning contracts. Canonical repository paths and process execution stay inside the repository module; raw SQL stays inside coordination mechanics.

## Protocol and external surfaces

The exact npm dependency recorded in `package.json` and `package-lock.json` is the sole shared wire-contract source: `@claudian-collab/protocol`, published from its standalone repository. Package version, canonical wire version, Cloud binding version, and backup format version are distinct identities. Their codecs and compatibility behavior are consumed from the package rather than reimplemented locally. LAN-only route bindings and physical Host-transfer semantics are not Cloud operations.

Capabilities describe complete composed operation paths. Production exposes Project creation and membership administration, snapshots, Requests and Tickets, Publish/Accept, personal-ref Git access, Project events, authority transfer, Leave, and Retire through the corresponding package bindings. A package upgrade alone does not enable a capability.

- `/livez` reports process liveness.
- `/readyz` reports whether startup and authority checks permit service.
- `/collab/capabilities` reports protocol compatibility, limits, and available features.
- Project JSON operations dispatch to their owning authorities.
- Git Smart HTTP invokes bounded `upload-pack` or `receive-pack` processes through repository authority.
- WebSocket events carry durable Project invalidations.
- Transfer artifact routes stream through bounded admission and the lifecycle's artifact authority.

Health and capability discovery do not require a Project principal and reveal no Project content, storage paths, or recovery details. Public errors are sanitized. Negative mutation settlement is carried only by an authority-created `ProjectMutationRejection`; status codes or missing rows do not prove that an ambiguous mutation never applied.

Events are committed with their coordination mutation and ordered by Project sequence. Process-local notifications wake subscribers but do not own history. Clients recover from unavailable history using a fresh snapshot. Membership and role changes re-evaluate event access and queued work.

## Coordination and repository isolation

One PostgreSQL database holds the shared canonical schema. Project-owned primary/foreign keys, uniqueness rules, and indexes retain `project_id` locality. The runtime role is distinct from schema initialization, is not a table owner, has no `BYPASSRLS`, and uses forced RLS with transaction-local Project context.

Cross-Project recovery, placement, and terminal-continuity catalogs expose bounded scheduling metadata. Each item re-enters the exact Project scope and rereads its authoritative records. A catalog row never grants ordinary Project admission or substitutes for a journal.

A placement lease identifies the Project, storage node, opaque storage key, and generation. Repository authority validates that lease against current state before execution and mutation. Repository lookup uses a Project namespace under the configured repository root; Project names never become paths. Normalized-path and real-path containment checks reject path escapes and symlink roots or entries.

Each Project has a protected main ref and Member personal refs. Receive-pack may update only authorized personal refs after expected-OID, reachable-tree, quarantine, and projected-quota checks. Accept owns the protected-main transition. Repository publication requires exact owned staging, live Git verification, and an atomic rename within the authority filesystem.

Git processes run with a controlled environment, server-owned configuration/hooks, bounded input/output and duration, and process-group termination. The deployment also limits the whole service container's resources. These mechanisms do not provide a separate per-Project OS or network sandbox.

## Write ordering and recovery

Every Project mutation shares one canonical PostgreSQL advisory-lock key. Database-only mutations use a transaction-scoped lock. PostgreSQL/Git workflows use the same key as a session lock on a checked-out connection, with short Project-scoped transactions inside that lease. Row locks follow Project admission. An ordinary transaction is never held open across Git, filesystem, or network waits.

Git-backed mutations acquire their Project-scoped resource reservation before the Project lease. Backup/export additionally reserves bounded coordination heap capacity. Recovery preflight runs without holding capacity that its recovery owner may need; after obtaining the correct reservation, the dispatcher re-enters the lane and rereads the journal. This ordering prevents receive-pack and lifecycle recovery from deadlocking each other.

PostgreSQL and Git do not commit atomically. A cross-store journal records exact operation identity, request fingerprint, expected revisions/OIDs, deterministic pre-effect facts, and possible versus confirmed progress. New mutations cannot pass an unresolved journal. Disconnects, missing files, and lost responses never establish completion or cancellation.

Business idempotency is Project/Member/operation intent scoped. The same accepted intent replays its retained result; a changed request with the same key is rejected. Revoked Members can recover only explicitly retained exact former-principal results, never ordinary Project access.

| Operation | Recovery boundary |
| --- | --- |
| Project creation | The persisted creation plan becomes forward-only at `prepared`; visibility begins only at activation. Exact partial repositories are completed, not deleted as cancellation. |
| Invitation Join | A reserved invitation becomes one pending Member with a pinned personal-ref plan. Preparation fences ordinary Project access until exact forward settlement completes. |
| Publish | Validates the persisted personal head and records collaboration state; it does not advance protected main. |
| Accept | Persists the deterministic commit plan, then its verified result OID, before protected-main CAS and SQL finalization. Cancellation cannot own a prepared Accept. |
| Removal/Leave | Persists the expected personal-ref OID before transactional membership/claim/work settlement; exact ref deletion follows and recovers forward. |
| Authority transfer | Target invalidation/cleanup proof permits cancellation before relinquishment. Relinquishment permanently fences the source and makes recovery forward-only. |
| Backup/export | Before publication, exact owned cancellation is possible. After publication, verification/completion are forward-only; export delivery expiry has a separate cleanup owner. |
| Project deletion | An authorized journal freezes the repository identity before removal; the same journal survives coordination-content deletion. |
| Environment restore | Before `authority-published`, only exact restore-owned state can be cleaned. After publication, the environment recovers forward to verification. |

Startup reconciles locally actionable recovery. An operation explicitly waiting for external proof stays fenced and cataloged while unrelated Projects may proceed. Contradictory state or an unsupported recovery kind is not interpreted as external waiting.

## Membership and authority transfer

Creation establishes an initial Manager. Ordinary invitations reserve membership capacity before redemption, and Join creates one exact pending Member and personal ref. Imported transfer claims are a distinct authority: they bind an existing imported Member and cannot create membership, choose a role, or authenticate connection access.

Manager responsibility is durable offer state with expected revisions and immutable expiry. A Project retains at least one active Manager. The final Manager can Leave only through the exact acknowledged succession offer. Removal and Leave revoke the affected bindings and claim authorities, settle offers and owned open work, remove structured mentions, and retain only permitted exact replay.

A transfer advances authority generation to exactly source generation plus one. Source quiescence, target staging, source relinquishment, and target activation remain separate durable facts. Before relinquishment, source reopen requires proof that the exact target has invalidated the transfer and cleaned its owned staging. After relinquishment, source admission never reopens, including after restart or failed target contact.

The transfer initially binds only the source Host or selected target Host through its direction's proof. Other imported Members remain unbound until claim redemption. Presence or device availability does not bind them.

Claim custody is protected at rest. A claim-batch acknowledgement proves custody, not redemption or permission to scrub. Only one batch revision is redeemable; rotation requires authoritative proof that custody did not commit and invalidates older hashes. Per-Member scrubbing requires the same former Member to forward an exact target-signed redemption receipt. Retained key references make claim and receipt continuity verifiable after restore without putting private keys in a backup.

Retire is Project-authorized and creates deletion intent. Operator `resume-delete` continues only an existing exact authorized journal. Deletion preserves the allowlisted non-content terminal continuity partition and tombstone without recreating membership, content, or placement. Read-eligible former principals do not gain target-only activation replay authority.

## Backup, restore, and export

Project checkpoints combine a versioned manifest, canonical logical coordination stream, and exact Git bundle. Transfer, backup, and export have separate profile allowlists. A portable checkpoint is not a raw PostgreSQL dump, a working tree, or a provider/Vault snapshot.

Backup/export captures one repeatable-read Project snapshot under its write lease and resource reservations. Exported refs are limited to protected main and retained Member refs. Nested coordination records and streamed bytes share bounded budgets; publication retains exact digests and ownership identity.

Environment backup drains lifecycle recovery before enumeration and captures both active Projects and terminal-only continuity. Pending external proof or an unclassified recovery obligation prevents a complete backup. A published artifact/catalog becomes a verified backup only after isolated restore, repository integrity verification, and representative Project and claim/replay reads succeed.

Clean restore requires empty target database and authority storage with runtime admission closed. Its private environment journal is paired with the database authority and volume marker and does not enter the Project recovery catalog. Catalogs, artifacts, key references, and protected envelopes are validated before target publication. Missing or wrong custody keys fail closed.

The deployment-owned keyring is mounted separately, read-only. Backup artifacts contain protected ciphertext and required references, not raw claims or private keys. Restored storage adopts the target environment identity while retaining the source identity needed to authenticate protected-envelope associated data.

Export delivery expiry is distinct from backup retention. The operator schedules the bounded `cloud-reconcile-exports` command; it re-enters each due Project's settlement owner instead of inferring cleanup authority from files. Off-host backup transport, artifact encryption, retention scheduling, and key distribution remain operator responsibilities.

## Installation artifacts and operations

Releases contain Docker images for Linux amd64 and arm64, an installation archive, and its checksum. `release.env` pins the matching image digest; the archive uses the shared Compose topology and requires no source checkout or local build. Actual runtime configuration is generated outside the release directory under `/etc/claudian-cloud-server`.

Compose uses host networking. Both PostgreSQL and the application bind to host loopback; the application port and PostgreSQL port are configurable independently. Separate environment files carry bootstrap, schema-initialization, and runtime credentials. The keyring is readable only by the configured runtime UID/GID. Configuration generation and fresh-volume ownership provisioning are short-lived privilege exceptions; the application remains unprivileged with a read-only root filesystem.

Fresh installation starts PostgreSQL, provisions the database roles/authority-volume pairing, initializes the absent canonical schema, and then runs restore recovery and Project recovery before the server. Runtime accepts only the exact current schema and never applies DDL. The PostgreSQL volume and authority volume form a persistent pair; losing one side does not authorize initialization of a replacement against the other.

The source-based deployment wrapper resolves an immutable candidate and verifies authority before recovery. Once its external recovery fence is recorded, retries use that same candidate and recover forward; the wrapper cannot reopen a predecessor after recovery mutation. An image replacement is not an in-place schema upgrade.

Resource admission bounds global/per-Project Git work, read/write classes, queued requests, streams, staging, and event subscriptions. PostgreSQL ordinary, pinned, and reserved pools have separate budgets. Container limits and runtime tuning values are documented in the configuration examples and README. Capacity tests exercise a named single-host workload; their synthetic workload sizes do not establish an Account model or a production hosting guarantee.

Readiness follows schema, database/volume pairing, recovery, key-reference, and repository-integrity checks. Periodic reconciliation starts after admission opens. Shutdown closes new admission, drains or cancels owned work, terminates child process groups, and disposes storage within the shared shutdown budget. A hung owner cannot prevent later owners from receiving close.

## Verification

Consumer contract tests validate the exact package dependency. Application tests use owning interfaces. Real PostgreSQL tests establish RLS, lock, transaction, schema, and connection behavior; real Git/process tests establish refs, containment, quotas, integrity, stream settlement, and process cleanup.

Fault injection interrupts cross-store work after durable phases and proves exact replay, permitted cleanup, forward recovery, or correctly scoped isolation across process restart. Backup/restore evidence includes terminal-only Projects and protected claim continuity. Deployment tests exercise Compose configuration, credentials, initialization, persistence, and bounded shutdown; release tests verify matching installation artifacts and generated configuration.

Commands and optional integration inputs are documented in [CONTRIBUTING.md](CONTRIBUTING.md). The repository does not implement operator ingress, managed billing, provider-backed coding agents, per-Project VMs, or distributed Git storage nodes.
