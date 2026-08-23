# Claudian Cloud Server Architecture

Status: foundation implemented; the steps 5–8 local Cloud milestone is accepted and frozen for implementation.

Last reconciled: 2026-08-21

## 1. Purpose

Claudian Cloud Server is the public, auditable collaboration data plane for
Claudian Collab. It keeps canonical Git repositories and authoritative
coordination state available independently of any participant device.

This document defines the initial architecture, ownership boundaries,
multi-Project isolation model, storage contracts, concurrency and recovery
semantics, deployment shape, capacity target, and evolution path. It is
decision-complete for scaffolding and the first private Cloud slice. Production
onboarding, trusted-ingress integration, commercial policy, and Cloud-to-LAN
migration remain separately gated where explicitly identified.

Repository-level constraints in `AGENTS.md` and the locked decisions in §3 are
authoritative.

## 2. Outcome

The first complete Cloud service provides one persistent authority for many
Accounts, devices, and Projects while preserving the existing Collab domain
semantics:

- one canonical bare Git repository per Project;
- one authoritative coordination projection per Project;
- one protected accepted ref and one coordinated Git write path per Project;
- active Project membership and server-owned role authorization for every
  operation;
- exact expected-version and expected-OID checks on mutations;
- idempotent replay wherever a client or server may retry;
- resumable recovery when Git and PostgreSQL cannot commit atomically;
- self-hosted and Claudian-managed deployments using the same public core;
- local Agents remaining on participant devices;
- Project contents, comments, credentials, and tokens excluded from telemetry.

The initial deployment is a modular monolith on one primary node. It is
logically multi-tenant by Project and physically shared. It does not allocate a
virtual machine or persistent container per Project.

## 3. Locked architecture decisions

1. **Project is the tenant boundary.** Project owns collaboration membership,
   authorization, managed-service eligibility evaluation, coordination state,
   repository placement, quotas, lifecycle, export, and deletion. No Team,
   Organization, or generic Tenant entity is introduced.
2. **Cloud is an authority, not a relay.** Participant availability does not
   determine Cloud availability.
3. **One Project has one canonical authority and repository placement.** No
   active-active or independent multi-writer Git topology is permitted.
4. **PostgreSQL and Git are separate authorities.** PostgreSQL owns
   coordination records; the bare repository owns Git objects and refs. No
   operation assumes atomicity across them.
5. **The first runtime is one deployable service.** API, Project events, Git
   Smart HTTP routing, and recovery coordination are modules in one process.
   PostgreSQL and repository storage remain external resources with separate
   lifecycle contracts.
6. **Logical isolation is mandatory from migration 1.** Every Project-scoped
   coordination relation and constraint carries `project_id`; every repository
   is resolved through authoritative placement.
7. **Virtualization is incremental.** The service and database use separate
   processes or containers. Git children are constrained. Per-Project VMs and
   persistent per-Project containers are not part of the initial design.
8. **Vertical scaling precedes distribution.** Stateless API separation and
   Project-sharded Git nodes are introduced only after measured need.
9. **The Cloud wire contract has one canonical owner.** Shared Cloud protocol
   types, executable codecs, operation definitions, compatibility behavior,
   and versioning are owned by a package produced from the `claudian`
   repository. This server implements that contract and does not copy it.
10. **LAN HTTP bindings are not the Cloud protocol.** Existing LAN protocol
    DTOs and transport-neutral codecs may be extracted where semantics match,
    but LAN routes, Host admission, invitation trust, and Host-transfer
    bindings remain LAN-owned.
11. **Ingress owns caller authentication; Cloud owns Project authorization.**
    Endpoint reachability, entry-access policy, and credential validation are
    external deployment responsibilities. Cloud consumes a trusted ingress
    principal. Clients may select a target Project, but they cannot assert
    authoritative Account, Member, role, entitlement, service state, or
    repository placement.
12. **Ordinary managed traffic is locally decidable.** Cloud Server uses local
    membership and versioned entitlement projections and does not synchronously
    call Site, Billing, the payment provider, or the Control Plane for each
    request.
13. **Backups require verified restoration.** A copied database or repository
    volume is not considered a successful backup until the combined authority
    can be restored and Git integrity verified.
14. **One advisory lock serializes every Project mutation.** Database-only and
    cross-store mutations use the same canonical PostgreSQL advisory-lock key.
    Row locks protect records only after Project admission and never substitute
    for the Project lock.
15. **Placement generation is an execution fence.** Every repository operation
    carries a server-derived placement lease. Stale generations and demoted
    nodes fail closed; placement is not merely routing metadata.
16. **The local milestone has three independent version authorities.** The accepted standalone registry release is `@claudian-collab/protocol` `1.0.0` with canonical wire version `4`; Cloud binding version `1` defines its routes and capabilities. The Claudian LAN control/event binding remains independently at version `9`. No adapter infers compatibility from package SemVer alone or couples a Cloud version change to the LAN binding.
17. **Durable phase records are singular authorities.** Activation, cancellation, client binding, and Accept each have one named journal or transition record. Membership, placement, repository directories, refs, indexes, and marker files are observations used to advance or reject that journal; none becomes a parallel phase authority.

## 4. System context and trust boundaries

```text
Participant device
+-- Claudian UI
+-- local working copy
+-- local Agent Runtime
+-- private conversations and provider sessions
        |
        | Cloud protocol + Git Smart HTTP
        v
Operator-owned trusted ingress
+-- endpoint reachability and entry-access policy
+-- caller authentication and credential validation
+-- trusted principal construction
        |
        | Cloud protocol + trusted IngressPrincipal
        v
Claudian Cloud Server
+-- request-context validation
+-- Project membership and role authorization
+-- coordination authority
+-- repository authority
+-- Project events
+-- recovery, export, retention, and deletion semantics
        |
        +-- PostgreSQL
        +-- bare repository storage

Private Control Plane, managed deployments only
+-- Account authentication
+-- device credential issuance and revocation
+-- Billing and Entitlement authority
+-- deployment and operational reconciliation
```

Cloud Server never receives or owns:

- raw caller credentials or user authentication flows;
- provider sessions, prompts, transcripts, or private Agent analysis;
- provider credentials or MCP configuration;
- Vault data outside the explicit Project;
- unfinished local drafts that have not been Published;
- managed billing-provider objects or production deployment credentials.

All code capable of reading or transforming Project files, diffs, comments,
Tickets, requests, Git objects, or coordination records remains in this public
repository.

## 5. Authority ownership

| State or behavior | Authoritative owner |
| --- | --- |
| Accounts and device credential issuance | Private Control Plane |
| Endpoint reachability, entry access, caller authentication, and presented credential validation | Deployment operator's trusted ingress |
| Accepted caller identity | Trusted ingress; Cloud consumes an immutable `IngressPrincipal` |
| Project identity and lifecycle | Cloud Server coordination store |
| Active membership and roles | Cloud Server coordination store |
| Managed entitlement fact per Account | Control Plane source; Cloud Server local versioned projection |
| Final Project managed eligibility | Cloud Server, combining active membership and entitlement projections |
| Requests, comments, Tickets, events, idempotency results | Cloud Server coordination store |
| Git objects, refs, protected `main`, personal refs | Canonical bare repository |
| Repository placement | Cloud Server placement store |
| Cross-store mutation progress | Cloud Server durable operation journal |
| Participant working tree and unpublished changes | Participant device |
| Cloud deployment and incident operations | Private Ops Control Plane |

Storage adapters own I/O mechanics. They do not decide membership, roles,
eligibility, mutation admission, or recovery policy.

## 6. Multi-Project isolation model

### 6.1 Request context and Project admission

Every request delivered to the Cloud data plane follows one admission path:

```text
trusted IngressPrincipal
  -> validate request-context shape
  -> load target Project
  -> resolve active Project membership
  -> evaluate service state and managed eligibility
  -> authorize the requested operation from the current server-owned role
  -> execute in a Project-scoped boundary
```

The deployment operator owns endpoint reachability, entry-access policy, caller
authentication, and credential validation. Its trusted ingress is the only
supported external path to Cloud Server. The production request-context adapter
receives the caller identity established by that ingress and constructs an
immutable `IngressPrincipal` containing a stable opaque Account or actor ID and
optional device or session attribution. The ingress-to-server identity channel
is not a client-writable Cloud protocol field. Preventing direct backend access
and forged ingress identity is a deployment requirement, not Cloud domain
policy. The private-development exception is defined in §10.1.

The production profile contract decides which attribution is mandatory.
Managed ingress must supply both the stable Account ID and device-credential ID
established upstream. A supported self-hosted ingress may supply only its stable
actor ID when it has no device concept. Missing attribution is never inferred
from client fields or source IP.

The request may carry the target `projectId` and operation parameters. It may
not supply authoritative `accountId`, `deviceId`, `memberId`, role,
entitlement, placement, or service state. Cloud validates principal and request
shapes but does not parse or verify caller credentials. Project admission
derives the active membership ID and role from authoritative Project state.
Audit records bind the accepted actor, optional ingress-provided device or
session attribution, derived membership, Project, operation, and result without
recording credential material.

Business idempotency is scoped to Project membership and operation intent, not
to one device. Its durable identity is `(project_id, membership_id,
operation_kind, idempotency_key)` plus a request fingerprint. Therefore the
same Member may retry the same intent from another accepted ingress context and
receive the original result; reuse for different intent fails deterministically.
Ingress-provided device or session attribution remains separately attributable
in the audit record when present.

Mutation authorization is revalidated at the final coordination transaction.
A request-start snapshot or client navigation hint never grants authority after
membership, role, eligibility, request revision, or expected Git state changes.
Caller-credential expiry, credential revocation, and termination of authenticated
long-lived ingress connections remain ingress responsibilities. Cloud does not
implement their lifecycle. Membership revocation stops Project admission for
every request context that resolves through that membership. When a membership
or role change reaches the process, queued work and Project event streams are
closed or re-evaluated, and long reads are cancelled where transport permits.
Every mutation revalidates membership, role, service state, and relevant
expected state immediately before its first irreversible durable effect. A
receive-pack does so in the final receive boundary before ref update. If a
membership or role change arrives after a durable Git CAS, recovery finalizes
the already-authorized operation but does not admit another one. No distributed
system can retract bytes already delivered before a change was observed, so
reads remain bounded by explicit operation deadlines.

### 6.2 Database isolation

The initial Cloud deployment uses one PostgreSQL database and one shared
application schema. It does not create a database or schema per Project.

Every Project-owned table has a non-null `project_id`. Primary keys, foreign
keys, uniqueness rules, and indexes preserve Project locality even when entity
IDs are globally unique. Representative constraints include:

```sql
CREATE TABLE change_requests (
  project_id uuid NOT NULL,
  request_id uuid NOT NULL,
  member_id uuid NOT NULL,
  status text NOT NULL,
  PRIMARY KEY (project_id, request_id),
  FOREIGN KEY (project_id, member_id)
    REFERENCES project_memberships(project_id, member_id)
);

CREATE UNIQUE INDEX one_open_request_per_member
  ON change_requests(project_id, member_id)
  WHERE status = 'open';
```

The schema follows these rules:

- Project-owned foreign keys include `project_id`;
- Project-scoped indexes normally lead with `project_id`;
- Ticket numbers are unique within a Project, not globally meaningful;
- stored idempotency identity includes Project, membership actor, operation
  kind, key, and request fingerprint;
- an event sequence is ordered within one Project;
- queries execute through a Project-scoped transaction or repository boundary;
- migration and runtime database roles are separate;
- the runtime role cannot alter schema or disable isolation policy.

Before external Alpha, PostgreSQL Row-Level Security is added as defense in
depth. Runtime transactions set a transaction-local Project context, and the
runtime role remains subject to RLS. Migration and narrowly controlled offline
repair roles are not used by ordinary request paths. RLS does not replace
application authorization or composite constraints.

The RLS design distinguishes Project execution from cross-Project discovery:

- the ordinary runtime role is not a table owner, has no `BYPASSRLS`, and is
  subject to `FORCE ROW LEVEL SECURITY` on Project content tables;
- `withProjectScope(projectId, principal, operation)` is the only ordinary
  transaction boundary that sets the transaction-local Project context;
- an Account's Project list comes from a narrow membership index or hardened
  database function that returns authorized Project summaries only; Project
  details are still loaded through one Project scope at a time;
- entitlement ingestion may update the minimum global Account-entitlement fact
  and enumerate affected Project IDs, but eligibility recomputation enters
  each affected Project's normal write lane;
- recovery, expiry, retention, deletion, and placement enumerators may read
  operation metadata and Project IDs only, then execute each item through the
  ordinary Project-scoped boundary;
- background and repair identities do not receive general Project-content read
  access merely because they enumerate work.

Any hardened database function fixes its `search_path`, validates caller-owned
identity from the accepted `IngressPrincipal` boundary rather than a
client-reported Account ID, and returns a deliberately bounded DTO rather than
arbitrary rows. Cross-Project metadata access has its own tests and database
grants; it is not implemented by giving the request runtime role unrestricted
table access.

The local milestone uses one dedicated recovery-candidate catalog for activation and Accept scheduling. A row contains only operation kind, opaque Project ID, opaque operation or attempt ID, and scheduling timestamps. Runtime enumeration is keyset-paged in stable order with at most 100 rows per page and cannot expose journal payload, membership, placement, report, Request, or Ticket data. Every nonterminal journal updates its candidate in the same PostgreSQL transaction; terminal completion or cancellation removes it. A scanner must acquire the canonical Project advisory lock, enter forced-RLS Project scope, and re-read the full journal before recovery. Startup scanning improves latency, but every Project admission repeats this check under the same lock, so enumeration is never the correctness boundary. An unreadable catalog, unknown authority-volume identity, or unclassified candidate holds global readiness false; a classified `recovery-required` Project blocks only that Project.

The package-owned bootstrap follow-up routes carry an opaque attempt ID but no caller-asserted Project ID. A separate minimal routing relation therefore maps one globally unique attempt ID to its Project ID. Runtime may insert that pair atomically with the scoped attempt and call one exact lookup function, but it cannot enumerate or read the relation directly. The lookup reveals no bootstrap payload and grants no admission: the caller must enter the returned Project's forced-RLS scope and re-read the exact attempt before actor and operation authorization.

### 6.3 Repository isolation

Each Project has exactly one bare repository. A placement record maps the
Project to an opaque server-generated storage key and storage node:

```text
RepositoryPlacement
+-- projectId
+-- storageNodeId
+-- repositoryStorageKey
+-- generation
+-- state
```

Repository storage keys are unique only within a Project. The local repository layout is `<root>/<project-namespace>/<storage-key>`, where `project-namespace` is the lowercase hexadecimal encoding of the canonical Project ID's UTF-8 bytes. This reversible encoding preserves case-sensitive Project identity on case-insensitive filesystems, uses only portable path characters, and keeps Project-owned placement constraints local without allowing two Projects with the same opaque key to resolve to one repository.

Every repository execution is bound to an immutable placement lease containing
`{projectId, storageNodeId, repositoryStorageKey, generation}` resolved during
Project admission. `GitRepositoryAuthority` validates the lease against current
placement state before starting Git and again at the final mutation boundary.
A stale generation, wrong node, non-active placement, or maintenance state fails
closed. Filesystem paths and remote-node mechanics never escape this authority
boundary.

User-controlled Project names never become repository paths. Repository lookup
resolves placement, constructs a path under one configured repository root,
and verifies normalized-path and real-path containment. Repository roots and
Project repository entries cannot be symlinks.

The Git authority enforces:

- server-owned repository configuration;
- server-owned hooks only;
- no inherited user or system Git configuration beyond an explicit allowlist;
- no credential, comment, description, diff, or content in process arguments;
- exact allowed-ref policy for personal and protected refs;
- expected-OID compare-and-swap for protected writes;
- pack, blob, tree, path, repository, process, time, and output limits;
- cleanup of every admitted Git child on completion, cancellation, or shutdown.

Before external Alpha, every operation that parses participant-controlled Git
input runs in a short-lived process sandbox or mount namespace. It can see only
the target repository, an operation-specific quarantine or staging area, the
required Git binaries and runtime libraries, and an empty explicit Git
configuration. It has no network access and receives bounded CPU, memory, PID,
filesystem, output, and duration budgets. This is per-operation containment,
not a persistent container or VM per Project.

Receive-pack is a Project mutation and holds the Project write lease through
its final receive decision. Incoming bytes are streamed against both a
Project reservation and a global free-space guard; `Content-Length` is only an
early rejection hint. Before ref update, the final boundary revalidates the
accepted actor-to-membership relation, service and placement state, unresolved
journals,
allowed refs, expected OIDs, quarantine contents, and projected reachable
repository size. Rejection discards quarantine and releases all reservations.

Personal refs use Project membership identity rather than Account ownership:

```text
refs/heads/members/<project-member-id>
```

### 6.4 Network and operational isolation

- PostgreSQL and repository storage are never directly exposed to participants.
- External traffic terminates at an operator-owned TLS reverse proxy for
  supported external deployments.
- The private development profile binds only to `127.0.0.1` and is reached
  through an operator-owned private forwarding arrangement.
- Source IP is never an Account or Member identity.
- Ops does not mount Project repositories and does not query collaboration
  tables directly.
- Backup and monitoring agents receive only the mounts and credentials required
  for their narrow function.

## 7. Runtime architecture

The service is one TypeScript package and one deployable process with one
composition root.

```text
src/
+-- main.ts
+-- composition/
|   +-- createApplication.ts
+-- config/
|   +-- ServerConfig.ts
+-- server/
|   +-- HttpServer.ts
|   +-- health/
|   +-- control/
|   +-- events/
|   +-- git/
+-- request-context/
|   +-- IngressPrincipal.ts
|   +-- RequestContext.ts
|   +-- DevelopmentRequestContext.ts
+-- project-authority/
|   +-- ProjectAuthority.ts
|   +-- admission/
|   +-- requests/
|   +-- tickets/
|   +-- acceptance/
|   +-- lifecycle/
|   +-- recovery/
+-- coordination/
|   +-- postgres/
+-- repositories/
|   +-- GitRepositoryAuthority.ts
|   +-- GitHttpBackend.ts
|   +-- GitCommandRunner.ts
|   +-- RepositoryPlacement.ts
+-- onboarding/
|   +-- development/
+-- resource-admission/
|   +-- ResourceAdmission.ts
+-- observability/
    +-- SafeLogger.ts

tests/
+-- contract/
+-- integration/
|   +-- postgres/
|   +-- git/
+-- fault-injection/
+-- capacity/
```

### 7.1 Dependency direction

```text
main/composition
  -> server adapters
  -> ProjectAuthority
       -> coordination contracts
       -> GitRepositoryAuthority
       -> request-context and eligibility contracts

server adapters
  -> shared Cloud protocol package
  -> ProjectAuthority

PostgreSQL and Git implementations
  -> owned domain contracts
  -/-> server transport
```

Rules:

- `main.ts` wires and closes owners; it contains no domain behavior;
- transport modules bind an accepted ingress principal, decode, stream, and map
  errors but never authenticate callers, issue SQL, or run raw Git commands;
- `ProjectAuthority` owns admission, authorization, idempotency, ordering, and
  cross-store recovery policy;
- PostgreSQL repositories own query, transaction, advisory-lock, connection,
  and pool mechanics, not policy; ordinary transactions, pinned Project leases,
  and reserved recovery/health work use explicit budgets, and request traffic
  cannot consume the reserved pool;
- `GitRepositoryAuthority` is the only module that resolves repository paths or
  starts Git processes; every call carries a validated placement lease rather
  than a raw path or independently resolved node;
- `ResourceAdmission` owns global and per-Project queues, Git-child permits,
  streamed byte reservations, and configurable overload decisions shared by
  control, Git, maintenance, and recovery paths;
- events are emitted from committed coordination mutations, not independently
  invented by route handlers;
- modules are introduced only when they hide meaningful behavior behind a
  smaller interface; pass-through wrappers are rejected.

### 7.2 Real seams

Only boundaries with actual alternative implementations receive ports:

- request-context binding: private-development actor assertion and production
  trusted-ingress principal;
- eligibility policy: unrestricted self-hosted behavior and managed local
  entitlement projection;
- repository placement: one local node initially and routed storage nodes
  later;
- coordination transport in tests versus the production PostgreSQL service;
- clock and ID generation for deterministic fault and idempotency tests.

Git command execution remains internal to `GitRepositoryAuthority`. The
external-Alpha sandbox and a future routed worker implement this same deep
boundary; neither creates a second domain API or exposes filesystem paths.

## 8. Protocol ownership and compatibility

The standalone `claudian-collab-protocol` repository produces `@claudian-collab/protocol`. The Cloud Server depends on the exact `1.0.0` npm registry release. That release carries the steps 5–8 canonical wire version `4` and Cloud binding version `1`; its npm lock entry records the immutable registry artifact integrity used by local development, CI, and deployments. Package SemVer, canonical wire version, Cloud binding version, and the independently owned LAN version are never substituted for one another.

The package exposes curated boundaries only:

- opaque IDs and public DTOs;
- stable limits and Git ref semantics shared by client and server;
- Agent-safe and client-safe error codes and sanitized context rules;
- executable request and response codecs;
- the Cloud operation catalog, HTTP bindings, event envelope, and compatibility
  policy.

It does not expose:

- Obsidian feature ports or UI state;
- local Projects-folder behavior;
- local Agent Runtime operations;
- SQLite or PostgreSQL schemas;
- LAN Host lifecycle, Host-transfer transport, or LAN route bindings;
- Git or Cloud credentials.

`IngressPrincipal` is a server-side deployment contract, not a client-writable
Cloud protocol DTO. Self-hosted and managed ingress adapters may construct it
from different authentication systems without changing collaboration semantics.

Self-hosted and managed Cloud use the same Cloud protocol. Deployment profile
does not fork collaboration semantics. Additive or breaking changes follow an
explicit protocol-version policy and contract tests run in both repositories.
The server never maintains a second hand-written inventory of the same
operations or validators.

## 9. External surfaces

### 9.1 Health and version

- liveness reports whether the process event loop and HTTP server are alive;
- readiness reports configuration, PostgreSQL schema compatibility, repository
  root availability, required Git capabilities, and recovery admission state;
- version reports the server release, protocol range, source revision, and build
  digest without exposing deployment secrets.

Readiness may remain true when one Project is isolated in recovery-required
state, provided other Projects can operate correctly and the affected Project
fails closed with an explicit status.

### 9.2 Control API

The control API implements the canonical Cloud operation registry. It binds the
accepted ingress principal, performs bounded decoding, Project admission,
application dispatch, and safe response/error encoding. The decoded client body
cannot populate or override ingress identity. The API never returns database
rows, internal Git refs, storage paths, credentials, or raw exception context.

### 9.3 Git Smart HTTP

Git transport uses `git http-backend` behind the same principal, Project
membership, service-state, quota, placement, and admission boundaries as the
control API. Read and write services are authorized separately. A successful
transport entry check does not bypass the final receive ref policy. Fetch runs
under bounded read admission. Receive-pack enters the canonical Project write
lane, uses a placement lease, and cannot update a ref until the final
authorization, journal, expected-OID, quarantine, and quota checks succeed.

The HTTP adapter owns streaming and disconnection detection. After handing a
response to the Git backend, it owns timeout, cancellation, child termination,
and response settlement explicitly.

### 9.4 Project events

Project events are durable, monotonic, redacted invalidations. They are not an
authoritative copy of request, Ticket, membership, or Git state.

- the coordination transaction appends the event with the mutation;
- event payloads contain identity and invalidation metadata, not content;
- clients resume from an acknowledged Project sequence;
- gaps, unknown kinds, or expired history require a fresh Project snapshot;
- an in-process hub may wake clients on the first node;
- PostgreSQL notification or a future broker is only a wake-up path; the event
  table remains authoritative;
- Cloud clients should open subscriptions lazily for active Projects. A later
  device-level multiplexed connection may carry multiple Project subscriptions
  without changing Project event semantics.

## 10. Ingress context and deployment profiles

### 10.1 Private development

The first two-device experiment runs under an explicit
`private-development` profile:

- the server must bind to `127.0.0.1`;
- an operator-owned private ingress publishes the accepted forwarding endpoint;
- startup fails if this profile is combined with a public bind or managed
  external-admission configuration;
- initial Project and role reports are accepted only through the bounded
  development bootstrap;
- subsequent development calls identify the claimed Member through a clearly
  named development-only assertion header;
- the server resolves that Member against its accepted authoritative Project
  state and never infers identity from source IP;
- the assertion header is excluded from logs and is not recognized by any
  other deployment profile.

This is an intentionally insecure actor assertion inside the operator's private
development network. The deployment operator owns endpoint access; Cloud Server
does not authenticate these development callers. The assertion is deleted or
disabled by construction before external Alpha.

The private bootstrap accepts only one active source Project with exactly two membership records total. Both records are active and correspond to distinct reporting Members; exactly one reporter is the current Host and at least one is a Manager. Pending or live invitations, pending memberships, collaboration records, nonterminal authority/lifecycle operations, undrained Project work, active Collab Git children, or mismatched local repository identity make the profile ineligible. Existing Git history is allowed, while unpublished working-tree changes, local commits, and private drafts stay local.

Before activation, the development principal may be matched only against the immutable attempt manifest and that actor's independently submitted report. The source Host actor alone may begin, upload, activate, or cancel; both accepted actors may submit only their own report and read bounded attempt status. After activation, `actor_id = member_id` mappings are persisted and every ordinary operation derives active membership and role from Cloud state. This pre-activation exception does not authorize a caller to assert role, service state, placement, or another Member's report.

### 10.2 Self-hosted Cloud

The operator owns endpoint reachability, TLS, entry-access policy, caller
authentication, and credential validation. The supported self-hosted ingress
constructs the same narrow `IngressPrincipal` contract and cannot assert roles,
eligibility, service state, or placement. Cloud Server still owns Project
identity, membership, roles, operation authorization, and routing. Self-hosted
mode does not depend on Claudian Billing, Entitlement, Site, or managed Ops.

### 10.3 Managed Cloud

The managed operator's trusted ingress authenticates the caller and supplies a
stable Account identity and device-credential identity through
`IngressPrincipal`. Managed Project admission then evaluates, in order:

1. active membership in the target Project;
2. current Project managed eligibility from local entitlement projections;
3. server-owned role authorization for the operation;
4. authoritative coordination or repository placement routing.

The external integration authenticates the source of entitlement updates before
delivery. Cloud applies versioned, monotonic, replayable, idempotent updates and
acknowledges them after application. Existing active Projects serve
ordinary traffic from local projections during bounded Control Plane outages.
New managed admission fails closed when required current facts cannot be
established.

## 11. Concurrency and Project write ownership

Every Project has one coordinated write lane. Reads may run concurrently when
they do not observe an invalid mixed snapshot, but every repository or
coordination mutation enters Project admission.

The initial single process uses an in-process Project queue for local fairness
and cancellation ownership. PostgreSQL provides the distributed authority when
multiple request processes or Git nodes later exist:

- every Project mutation first acquires the same PostgreSQL advisory lock key;
- database-only mutations acquire that key with a transaction-scoped advisory
  lock inside one short transaction;
- operations spanning PostgreSQL and Git acquire the same key with a
  session-scoped advisory lock on one checked-out PostgreSQL connection for the
  whole admitted workflow;
- row locks may be acquired only after the advisory lock and protect individual
  records; they never replace Project admission because PostgreSQL row locks do
  not conflict with advisory locks;
- the session lock releases automatically if the process or connection dies;
- a durable operation journal, not the lock, records recovery truth;
- every Git ref transition uses expected-OID compare-and-swap;
- a lock timeout returns a bounded busy/retry result instead of creating an
  unbounded queue.

Transaction-scoped and session-scoped advisory locks derive their key from one
canonical `ProjectLockKey` implementation and the same PostgreSQL advisory-lock
namespace. No module hashes or casts a Project ID independently. The fixed lock
order is: in-process fairness queue, checked-out connection when required,
Project advisory lock, recovery admission check, and then row locks inside each
required short database transaction. A cross-store workflow commits its durable
checkpoint before the corresponding Git effect and never keeps the ordinary
transaction open across that effect. Code may not wait for another Project lock
while holding one. Concurrency integration tests on real PostgreSQL connections
prove that database-only and cross-store mutations contend on the same Project
while different Projects remain independently executable.

The distributed write lock is also a recovery admission fence. After acquiring
it, and before admitting any new Project mutation, the owner must:

1. read the Project service state and every non-terminal cross-store journal;
2. recover or finalize the existing operation when its outcome is provable;
3. otherwise durably mark the Project `recovery-required` and reject the new
   mutation;
4. admit new work only after proving that no unresolved operation remains.

A database constraint permits at most one non-terminal cross-store write
operation per Project. Startup scanning improves recovery latency but is not a
correctness boundary: another live process must perform the same admission
check immediately after it acquires the Project write lock.

The application never holds an ordinary PostgreSQL transaction open while
waiting for a long Git process. It commits the recovery checkpoint first, runs
the Git step under the broader Project write lease, then opens the next short
transaction to advance or finish the journal.

## 12. Cross-store consistency and recovery

### 12.1 General protocol

Every cross-store operation is a state machine with:

- a stable operation ID and client idempotency identity;
- a request fingerprint preventing key reuse for different intent;
- exact expected coordination versions and Git OIDs;
- a durable pre-Git checkpoint;
- an explicit record of possible or confirmed Git progress;
- idempotent finalization;
- startup and on-demand recovery;
- a fail-closed Project state if observed Git and journal state cannot be
  reconciled.

No new mutation may pass an unresolved journal. Journal states and their exact
Git/coordination preconditions are part of mutation admission, not merely
diagnostic records inspected after restart.

An ambiguous timeout or disconnect never proves that a write failed. The
caller re-reads authoritative state before retrying the same intent.

### 12.2 Publish

Git receive-pack updates only the authorized Member's permitted personal
ref under expected ref policy. The subsequent Publish/request command:

1. revalidates the actor's active membership;
2. resolves the exact canonical personal-ref head;
3. validates expected accepted main and complete reachable-tree policy;
4. creates or updates that Member's single open request;
5. stores the idempotency result and redacted event in the same PostgreSQL
   transaction.

Publish never advances protected accepted state.

### 12.3 Accept

Accept uses four durable phases under one pinned Project write lease:

| Phase | Durable meaning and permitted next effect |
| --- | --- |
| `prepared` | PostgreSQL holds the actor, normalized fingerprint, reviewed request revision and personal-ref OID, expected main OID, exact relations and resolving-Ticket revisions, placement generation, and the deterministic commit plan. Main has not been intentionally changed. |
| `result-persisted` | Repository authority has recreated or created the exact deterministic result object, parsed it back, and PostgreSQL holds the verified result OID. Main may still equal expected or may already equal result after a lost response. |
| `main-updated` | Protected main has been verified at the persisted result OID after expected-OID compare-and-swap or the contained fast path. SQL domain finalization may still be incomplete. |
| `completed` | One PostgreSQL transaction marks the Request merged, promotes accepted relations, closes only the exact resolving Tickets, advances `projects.expected_main_oid`, appends `main.updated`, persists the idempotent result, and removes the recovery candidate. |

The deterministic plan fixes repository object format and placement generation; the validated tree; ordered parents `[expectedMainOid, expectedHeadOid]`; author and committer `Claudian Collab <collab@claudian.local>`; the `preparedAt` instant truncated once to whole Unix seconds with timezone `+0000`; exact UTF-8 message bytes `Accept request <requestId>\n`; and the reviewed Request/Ticket tuple. Repository authority creates the commit without checkout or ambient Git configuration and parses the object back to verify every field and OID before main CAS.

Ordinary cancellation no longer owns the operation after `prepared`. Recovery recreates only the deterministic object recorded there. When main equals expected, it may persist the result and repeat the exact CAS; when main equals the verified result, it advances without rewriting; when main equals neither, or any placement, object, phase, or SQL observation contradicts the journal, the Project becomes `recovery-required`. A crash after object creation but before `result-persisted` leaves an ignorable dangling object, not an alternate authority. The contained fast path records and verifies the already-contained result without a protected-ref write.

### 12.4 Development onboarding

The private bootstrap is isolated from normal Project admission. Attempt state is exactly `collecting`, `validating`, `ready`, `activating`, `rejected`, `cancelled`, `recovery-required`, or `activated`. The former Host must persist its non-restart stop fence, drain Project work and Git children, and stop LAN authority before the Host actor may begin. Two actor-bound reports must independently agree on the immutable logical JSON manifest, exact two-Member authority state, repository identity, protected and personal refs, and readiness. The source Host streams one raw Git bundle; SQLite, Project-directory archives, credentials, CA material, Vault data, unpublished files, local-only commits, and drafts are never uploaded. Upload admission transfers atomically from the canonical Project lock to an attempt-scoped PostgreSQL shared advisory fence on the same pinned session. Settlement holds the Project lock while draining the matching exclusive fence, so no process can start or retain staging work past publication or cleanup.

Activation has four durable phases:

| Phase | Durable meaning and permitted next effect |
| --- | --- |
| `publish-intent` | Validation is complete, the target Project ID and placement are reserved, and activation recovery exclusively owns settlement. Cancellation may no longer delete or roll back authority state. |
| `repository-published` | A validated bare staging repository and marker were atomically renamed to the sibling canonical path on the same authority filesystem; the object format, exact refs/OIDs, and strict Git integrity are reverified from the live repository; Project state remains invisible to ordinary admission. |
| `activated` | One Project-scoped PostgreSQL transaction creates the active Project with Cloud manager-set generation `0`, exactly two active memberships with preserved display names, development actor mappings, expected refs, active placement generation `1`, the bounded active-placement catalog entry, and the replayable activation result. This is the Cloud authority and visibility boundary. |
| `completed` | Exact attempt-only staging and reservations are cleaned, the stable result remains replayable, and the recovery candidate is removed. |

Cancellation is allowed only before `publish-intent` and has phases `cancel-intent`, `cancelled`, and `recovery-required`. `cancel-intent` freezes further report/upload/activation admission before deleting attempt-owned staging; `cancelled` proves those resources are absent and stores the stable result. Contradictory ownership or cleanup observations become `recovery-required`. Expiry uses the same cancellation owner and may clean only paths proven to belong to an invisible attempt. Startup settlement is followed by one lifecycle-owned periodic scanner, so the fixed attempt lifetime remains enforced while the process stays running; scans never overlap and shutdown cancels the next scan before draining an active one. Filesystem presence, absence, or a marker alone never proves activation or cancellation.

This flow is not the production LAN-to-Cloud cutover protocol. Production
freeze, proof, resumable upload, activation, rollback, redirection, and
split-authority prevention require a separate accepted design before external
use.

### 12.5 Claudian local Cloud binding

Cloud activation does not wait for client-local state. Each client first persists a transition `intent` and keeps the former Host's non-restart fence active. Terminal binding begins only after Cloud snapshot and upload-pack are available, and each client repeats readiness immediately before changing local authority.

The one transition record advances through `intent`, `readiness-confirmed`, `origin-rotated`, `cloud-verified`, `membership-replaced`, `index-repaired`, `lan-authority-retired`, and `fence-terminal`. `membership-replaced` is the adapter-selection boundary: the strict tagged Cloud membership record becomes authoritative even if the derived Project index still needs repair. `lan-authority-retired` atomically moves only the former Host's exact inactive authority directory to an inert attempt-scoped private directory; the other client records a no-op. `fence-terminal` retains a terminal non-restart fence, recreates one Project work session from the Cloud record, and completes binding.

Recovery resumes from the durable phase plus exact observed URL, repository identity, membership, index, and retired-authority state. It never restores LAN authority after Cloud `activated`. The Cloud membership stores only canonical server URL, Cloud binding and wire versions, derived Git URL, and development actor ID; it stores no active LAN credential, CA, Host ownership, or duplicate recovery phase.

### 12.6 Production Project creation gate

The private first slice advertises no production Project-creation operation.
Before external Alpha, one production path is selected: Cloud-native creation
or the complete existing-LAN onboarding handoff. Cloud-native creation remains
the smaller candidate because it does not require an authority cutover.

The selected path must define its durable phases in the same change that brings
the feature into the implementation sequence. A Cloud-native design must keep
the Project invisible until initial membership, coordination state, a validated
bare repository, and active placement generation `1` are recoverably bound. It
must specify stable operation identity, request fingerprinting, activation
ordering, abandoned-staging cleanup, idempotent replay, and failure recovery
without inferring authority from directory presence. No production creation
route or speculative creation module is scaffolded before that contract is
accepted.

## 13. Project service and storage lifecycle

The architecture recognizes these semantic states without requiring every
future transition in the first slice:

- `active`: reads and authorized writes admitted;
- `read-only-transition`: clone, fetch, read, and export admitted; collaboration
  mutations rejected;
- `maintenance`: bounded Project-scoped operation such as placement migration;
- `recovery-required`: reads allowed only where correctness can be proven;
  affected writes fail closed;
- `deleting`: idempotent deletion journal owns progress;
- `deleted`: only the minimum non-content tombstone remains.

Onboarding staging is not a Project authority state and cannot serve traffic.
A Project becomes durable only after activation.

Subscription loss changes a managed Project to `read-only-transition`; it does
not immediately delete data. Restoration of sponsorship restores the same
Project in place before the deadline. Expiry begins a separate deletion
transaction. Cloud-to-LAN handoff remains a distinct authority transfer and
must complete before Cloud canonical writes stop or deletion begins.

Participant Leave, Project-wide Retire, managed-service deletion, and
Cloud-to-LAN handoff are four separate lifecycle operations:

- Leave terminates one membership and must preserve one-or-more active Manager
  continuity when Manager administration is enabled;
- Retire terminates the collaboration relationship for every participant and
  is not a billing or retention action;
- managed deletion removes Cloud data after the applicable service lifecycle
  and never claims that collaboration was Retired;
- Cloud-to-LAN handoff transfers canonical authority and is not an export or
  deletion shortcut.

The first private Cloud slice advertises none of the Cloud Leave, Retire, or
authority-handoff mutations. Their Cloud protocol and recovery semantics remain
deferred. In particular, the LAN `retireProject` operation, terminal responder,
Host acknowledgement behavior, and Host-transfer semantics are not reused as
Cloud bindings. Before an external milestone enables membership administration,
Cloud Leave and last-Manager succession must have an accepted contract. No
user-visible Cloud Retire endpoint is exposed until terminal distribution,
acknowledgement, retention, and cleanup behavior is decided.

## 14. Resource isolation and quotas

Multi-Project capacity is protected by bounded admission rather than
per-Project virtualization.

Initial controls include:

- one active mutation lane per Project;
- global and per-Project Git child limits;
- separate limits for read-oriented and write-oriented Git work;
- bounded waiting queues and explicit busy/retry responses;
- HTTP body, header, connection, and handler limits;
- Git request, pack, blob, tree, path, changed-path, output, and duration limits;
- per-Project soft and hard repository quotas;
- database pool and statement timeouts;
- event replay and WebSocket connection limits;
- disk free-space admission guard;
- cleanup and expiry of staging, failed uploads, and temporary Git data.

A 4 vCPU node should initially run no more than four heavy Git children at once.
Fetch-oriented operations may be raised toward eight only after measurement.
Ten to twenty simultaneous Git requests may be admitted with excess work
bounded in a queue. Limits are configuration with safe defaults, not scattered
route constants.

## 15. Virtualization and deployment evolution

### 15.1 Private development and early Alpha

```text
Primary host
+-- operator-owned private entry boundary
+-- Cloud Server process or container
+-- PostgreSQL process or container
+-- persistent bare repository volume
+-- backup agent -> encrypted off-host storage
```

Isolation requirements:

- separate process/container and credential lifecycles;
- Cloud Server runs as an unprivileged user;
- PostgreSQL is not publicly reachable;
- repository storage is writable only by the Cloud Server data-plane identity;
- Ops has no repository mount;
- off-host backup material and recovery instructions survive total host loss.

### 15.2 External Alpha hardening

Before external participants upload Project data:

- integrate with a production trusted ingress that owns Account/device
  authentication and constructs the accepted `IngressPrincipal` outside Cloud
  Server;
- define stable opaque mappings among Account, device, Project, membership,
  protocol actor, and repository identity;
- provide at least one production-safe Project authority creation path:
  ingress-authorized Cloud-native creation or the complete existing-LAN
  onboarding handoff;
- if existing LAN Projects enter scope, implement paid-active-member
  authorization, one-time upload authority, freeze and checkpoint proof,
  resumable staging, activation, rollback, client redirection, and
  split-authority prevention;
- require the deployment operator to place TLS, entry access, and request
  protection at the supported external ingress boundary;
- apply database runtime roles and RLS;
- run participant-controlled Git parsing in a short-lived target-repository-only
  sandbox, with an operation quarantine and OS/container CPU, memory, PID,
  filesystem, output, duration, and network-denial policies;
- enforce streamed Project and global byte reservations plus quarantine and
  projected reachable-repository quotas at the final receive boundary;
- make the container root filesystem read-only except for explicit repository
  and staging mounts;
- complete security, privacy, logging, retention, deletion, backup, restore,
  and operator-access claims;
- prove cross-Project isolation and verified restoration.

Containers reduce deployment and process blast radius but are not treated as
cryptographic tenant isolation.

### 15.3 Project-sharded Git tier

When storage, Git CPU, backup windows, or recovery objectives exceed one node,
new Projects are placed on additional Git nodes:

```text
API and event tier
        |
   PostgreSQL
        |
Repository placement
    +---+---+
    |       |
Git node 1  Git node 2
```

An existing Project moves only through a journaled maintenance operation. Every
repository command is already bound to a placement generation, so distribution
does not change the `ProjectAuthority` or `GitRepositoryAuthority` domain API.
Migration remains disabled until its implementation change adds a
decision-complete durable phase table and fault tests covering write freeze and
drain, exact ref and reachable-object copy, target verification, monotonic
source fencing, authoritative cutover, target reopen, and old-copy cleanup.
The source must durably reject generation `g` before the target at `g + 1`
accepts writes. A delayed request, stale routing result, or restarted old node
must fail after that fence, including when placement authority is unavailable.
Two placements never independently accept canonical writes.

Per-Project VMs, persistent per-Project containers, Kubernetes, Redis,
active-active Git, and distributed consensus are not initial requirements. The
short-lived external-Alpha Git sandbox is an internal execution control and
does not change the Project deployment model.

## 16. Capacity model and staged targets

The required product stages are an A test with 20-80 registered Accounts, a B
test with 100-500 registered Accounts, and a post-Beta architecture that reaches
at least 1,000 registered Accounts without changing the domain, protocol,
authorization, coordination schema, or repository-authority boundaries. The
initial A-test machine is not required to host the 1,000-Account workload.

Registered Accounts alone are not the main capacity variable. The service
measures distinct Projects and memberships, active devices, event
subscriptions, repository count and size distribution, Git child CPU and RSS,
operation mix and latency, database pool wait, network transfer, backup age,
and verified restore duration.

Ordinary-use estimates assume Markdown-first repositories with some images or
PDFs, an average bare repository size of 50-200 MB, approximately three to four
Project memberships per Account at larger stages, one to two Projects touched
per active day, infrequent Publish and Accept compared with reads, and no
abusive load. The DAU and concurrency values below are engineering test
assumptions to be replaced by observed distributions, not product commitments.

### 16.1 Planning envelope

| Stage | Registered Accounts | DAU test assumption | Peak active Accounts / connected devices | Projects and repositories | Memberships | Live subscriptions target / cap |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| A test | 20-80 | up to 40 | 20 / 25 | 60 expected; test 100 | approximately 240 | 50 / 200 |
| B test | 100-500 | up to 150 | 75 / 100 | test 500 populated repositories | 1,000-2,000 | 500 / 1,000 |
| Post-Beta | at least 1,000 | up to 300 | 150 / 200 | 1,000 expected; test a 2,000-repository catalog | approximately 4,000 | 1,000 / 2,500 |

An initial product limit of 50 active memberships per Project and five live
Project subscriptions per device is conservative until larger Projects are
benchmarked. By B test, one device-level connection should multiplex multiple
Project subscriptions while each Project keeps its own durable event sequence.
WebSockets never reserve PostgreSQL connections.

### 16.2 Deployment envelope

| Stage | Planning topology | Live repository envelope | Interpretation |
| --- | --- | ---: | --- |
| Lower A test | 2 vCPU, 4 GB RAM, 80 GB SSD | 6-20 GB | Sufficient for private development and light testing. |
| Upper A test / B-test start | 4 vCPU, 8 GB RAM, 250 GB SSD | up to approximately 100 GB | Starting topology, not a high-end 500-Account commitment. |
| Upper B test | 8 vCPU, 16 GB RAM, 500 GB NVMe | approximately 100 GB plus growth and staging | Preferred before admitting the high end of B test. |
| Post-Beta single node | 8 vCPU, 16 GB RAM, 1 TB NVMe; consider 16 vCPU and 32 GB RAM when PostgreSQL remains collocated or binary load is high | 200 GB expected; test 400 GB | Plausible for 1,000 registered Accounts under bounded admission; shard Projects when measured thresholds fail. |

API and ordinary PostgreSQL queries are expected to have more headroom than Git
pack processing, disk and network transfer, noisy repositories, backup windows,
and restoration. Repository capacity reserves at least 40% of the volume for
growth, incoming packs, maintenance, staging, and operational headroom:

```text
project_capacity ~= repository_volume * 0.60 / average_repository_size
```

At the upper catalog envelope, 2,000 repositories at a 200 MB average consume
approximately 400 GB live. Preserving the 40% reserve requires at least about
667 GB before backup workspace or filesystem overhead, so the supported
planning tier is 1 TB rather than 500 GB.

### 16.3 Provisional admission defaults

These values are safe starting configurations for benchmarking. They remain
central configuration owned by resource admission and must be reduced or raised
from observed Git CPU, RSS, I/O, queue, and PostgreSQL-pool behavior.

| Limit | A test | B test | Post-Beta test |
| --- | ---: | ---: | ---: |
| Control requests in flight | 32 | 128 | 256 |
| Ordinary PostgreSQL transaction pool | 8 | 16 | 32 |
| Pinned Project-lease connections | 2 | 4 | 8 |
| Reserved recovery, migration, and health connections | 2 | 4 | 4 |
| Admitted Git requests, including queued work | 6 | 20 | 50 |
| Running Git children | 2 | 4 heavy; up to 8 fetch-only after measurement | 8 mixed; no more than 6 heavy until measured |
| Clone / fetch / push workload envelope | 1 / 3 / 2 | 2 / 12 / 6 | 4 / 34 / 12 |
| Concurrent Publish requests across Projects | 2 | 8 | 16 |
| Concurrent Accept requests across Projects | 1 | 2 | 4 |

One Project still admits only one mutation at a time. Initially it admits at
most two concurrent Git reads and four queued requests. All Git subprocesses,
including Smart HTTP, Accept, validation, maintenance, and backup verification,
consume one global child budget. Queue wait starts with a ten-second maximum;
Project-lock acquisition and ordinary statement timeouts start near two
seconds, and routine mutation statements near five seconds. Maintenance uses a
separate explicit budget rather than silently widening request timeouts.

### 16.4 Stage acceptance workloads

All stages require zero cross-Project reads, events, ref writes, or backup
content; zero protected-ref divergence or unresolved-journal bypass; and no
leaked Git child, pinned database connection, staging path, reservation, or
event subscription after cancellation or restart. Provisional service gates are
control API p95 at or below 250 ms and p99 at or below one second outside
explicit Git queue time, event invalidation p95 at or below two seconds,
database pool wait p95 at or below 100 ms, and unexpected 5xx below 0.5%.
Overload must appear as bounded retryable admission rejection. Sustained CPU
should remain below 70%, memory below 75% without swapping, and the repository
volume must preserve its 40% reserve.

- A-test acceptance seeds 80 Accounts, 100 Projects, approximately 240
  memberships, and 50 subscriptions. It runs the A-test operation mix for one
  hour plus an eight-hour soak, injects restart during push, Publish, Accept,
  and backup, and restores the full dataset within the §18 objective.
- B-test acceptance seeds 500 registered Accounts, 500 Projects, 1,000-2,000
  memberships, 500 subscriptions, and approximately 100 GB of live Git data.
  It includes a 100-simultaneously-active-Account stress profile, 20 admitted
  Git requests with four heavy children, eight Publish and two Accept requests
  across independent Projects, an eight-hour target run, a 24-hour soak, and a
  500-subscription reconnect storm.
- Post-Beta acceptance seeds 1,000 Accounts, approximately 4,000 memberships,
  1,000 populated repositories plus a 2,000-repository catalog test, 1,000
  subscriptions, and 200-400 GB of live Git data. It runs 50 admitted and eight
  running Git requests, 16 Publish and four Accept requests, a 24-hour soak,
  deployment restart, backup under load, and a 1,000-subscription reconnect
  storm.

Vertical scaling or resource separation is triggered when CPU remains above
70% for 15 minutes, event-loop lag exceeds 50 ms, memory remains above 75%,
database pool utilization exceeds 70%, pool-wait p95 exceeds 100 ms, Git queue
wait p95 exceeds five seconds, ordinary-load admission rejection exceeds 1%, or
capacity is forecast to consume the 40% disk reserve within 90 days.

Project-based Git sharding is triggered when repository data reaches 60% of
usable node volume, Git queue objectives still fail after economical vertical
scaling, a backup takes more than half its interval, full restore exceeds 75%
of its RTO, or one Project repeatedly consumes more than 10% of repository
storage or 30% of Git processing time. These are operational investigation
thresholds, not automatic migration commands.

## 17. Observability and sensitive-data policy

Telemetry may include:

- opaque Project and operation IDs;
- route template, operation kind, status, safe error code, and duration;
- Git service kind, child duration, exit class, CPU, memory, and byte counts;
- repository size and growth counters;
- database pool, query class, and latency metrics;
- queue depth, admission rejection, event lag, backup age, and restore duration.

Telemetry must never include:

- file contents, diffs, comments, Ticket bodies, or request descriptions;
- credentials, authorization headers, tokens, private keys, or invitation data;
- raw request/response bodies;
- repository filesystem paths or customer exports;
- process arguments containing Project content.

The logger uses explicit serializers and sanitized domain errors. Raw exceptions
from PostgreSQL, Git, filesystem, or transport dependencies do not cross the
public error boundary or enter ordinary logs without sanitization.

## 18. Backup, restore, export, retention, and deletion

Infrastructure snapshots may move encrypted bytes off-host, but Cloud Server
owns application semantics.

The initial engineering recovery objectives are explicit but provisional until
measured on the selected storage and backup provider:

| Stage | Maximum RPO | Full-service RTO | Clean-restore dataset |
| --- | ---: | ---: | ---: |
| A test | 24 hours | 8 hours | up to 20 GB live repositories plus coordination state |
| B test | 6 hours | 4 hours | approximately 100 GB live repositories plus coordination state |
| Post-Beta | 4 hours | 4 hours | 200 GB expected and a 400 GB upper-envelope exercise |

RPO is measured from the newest verified off-host checkpoint, not from a local
snapshot or upload start time. Retention preserves at least seven daily and four
weekly verified restore points plus the interval checkpoints needed to meet the
active RPO; commercial retention may be longer. Capacity planning initially
reserves approximately two to three times live data for incremental or
deduplicated off-host history and replaces that factor with observed change
rates. Full independent copies at every interval are not assumed.

A backup record identifies:

- database backup identity and schema version;
- repository backup identity and placement generation;
- exact Project refs or checkpoint manifest required for validation;
- capture time, verification status, and retention class.

Cross-store backup does not claim impossible atomicity. The first supported
application backup uses a Project-scoped quiesced checkpoint:

1. acquire the Project write lease and resolve every non-terminal journal;
2. durably enter a backup maintenance operation that blocks new Project writes;
3. export the Project's coordination state and record its schema version,
   generation, and checksum in a short PostgreSQL transaction;
4. capture exact Git refs and reachable objects while the same write lease
   remains held;
5. verify the repository artifact and write one manifest binding the
   coordination export, placement generation, refs, objects, and checksums;
6. durably mark the local checkpoint captured, reopen Project writes, and
   release the write lease;
7. transfer the encrypted artifact off-host, verify its remote identity and
   checksum, then mark the backup record complete.

The service does not hold a PostgreSQL transaction open during the Git capture.
The durable maintenance operation and Project write lease preserve the
checkpoint. Failed attempts do not publish a complete backup record and are
cleaned or resumed idempotently.

Before backup implementation begins, the same change must define the exact
durable phases, side effects, cleanup ownership, and recovery observations for
coordination capture, repository capture, checkpoint publication, off-host
transfer, and verification. The high-level sequence above constrains that
design but does not predeclare persistence state names before the selected
storage mechanism is known.

Backup scheduling prioritizes Projects changed since their newest verified
checkpoint and runs a bounded number of different Projects concurrently. All
Git verification children share the ordinary global child budget. The fleet
checkpoint window must finish within half the active backup interval. A single
Project checkpoint starts with a p95 write-quiescence objective of 60 seconds
and a hard attempt budget of five minutes; exceeding the budget aborts and
retries rather than silently blocking Project writes. Repeated misses require
incremental, deduplicated, or snapshot-capable storage before advancing the
stage.

The completed manifest binds one Project ID, backup operation ID, coordination
schema version and generation, proof that no earlier non-terminal journal
remained at the checkpoint, repository placement generation, the complete
captured ref/OID set, repository artifact checksum, coordination export
checksum, and completion timestamp. Restore rejects a package when any bound
value is missing, mismatched, or references unreachable Git objects.

Verification restores into a clean environment, validates database integrity,
runs Git repository integrity checks, confirms required refs and reachable
objects, and exercises a representative Project read.

Export produces an explicit Project package containing the repository and the
portable coordination records required by the product contract. It excludes
credentials, entitlement projections, operational metadata, and private
Control Plane state.

Deletion is a separate idempotent journaled operation. Participant-local copies
are never deleted by Cloud. Before deletion is enabled, its implementation
change must define a durable phase table covering traffic denial, retention
decision, repository and coordination removal order, minimum non-content
tombstone creation, retry, and cleanup. Partial deletion never returns a
Project to active, recreates a missing repository, infers success from an absent
directory, or loses the evidence needed for idempotent replay. Unreconciled
state remains non-admissible and requires recovery.

## 19. Lifecycle and shutdown

### 19.1 Startup

1. decode and validate configuration without logging secrets;
2. enforce deployment-profile safety constraints;
3. initialize safe logging and process-level failure handling;
4. connect with the runtime PostgreSQL role and verify schema compatibility;
5. verify repository root ownership, containment, capacity, Git version, and
   required capabilities;
6. inspect and schedule durable operation recovery;
7. mark only unreconciled Projects as recovery-required when isolation is safe;
8. enumerate the bounded active-placement catalog, re-enter each Project under its canonical lock, and verify live Git integrity plus exact main and Member refs;
9. start HTTP admission and publish readiness.

Production schema migration is a separate command using a migration role.
Application startup verifies the schema and fails closed on unsupported
versions rather than silently applying privileged migrations.

### 19.2 Shutdown

1. mark readiness false;
2. stop new control, Git, event, and onboarding admission;
3. close event subscription admission and notify clients to reconnect where
   possible;
4. abort bounded reads and allow admitted writes with possible durable progress
   to settle within the shutdown budget;
5. terminate remaining Git children, escalating after a deadline;
6. preserve durable journals for any forced or ambiguous termination;
7. release Project write leases and close the PostgreSQL pool;
8. close the HTTP server and process-owned resources.

Forced process death is expected. Correctness comes from exact preconditions,
Git CAS, and durable recovery journals rather than graceful shutdown alone.

## 20. Verification strategy

### 20.1 Contract tests

- every advertised Cloud operation has one request and response codec;
- client and server fixtures round-trip across the pinned protocol version;
- unknown fields, invalid IDs, unsupported versions, and oversized values fail
  closed according to compatibility policy;
- public errors contain only approved safe context.

### 20.2 Multi-Project isolation tests

Tests create at least two Projects with deliberately overlapping display names,
Ticket numbers, descriptions, and Member names, then prove:

- a principal from Project A cannot read, subscribe to, clone, fetch, push, or
  mutate Project B;
- Project A IDs cannot be combined with Project B foreign keys;
- a Request cannot reference a Ticket or Member from another Project;
- event replay never crosses Project boundaries;
- repository placement cannot escape through traversal, malformed IDs, or
  symlinks;
- denial responses do not reveal whether an unrelated Project or entity exists.

### 20.3 PostgreSQL integration tests

- migrations apply to an empty supported PostgreSQL instance;
- runtime-role permissions and RLS are effective;
- the runtime role is not a table owner, cannot bypass or disable RLS, and
  receives no Project rows without an explicit Project context;
- an incorrect Project context cannot reveal another Project's data;
- Account Project listing returns authorized summaries only;
- entitlement and recovery enumerators see bounded metadata and enter each
  Project through the ordinary scoped write lane;
- composite constraints enforce Project locality;
- idempotency and event records commit with their mutation;
- a same-intent idempotency retry from a second accepted ingress context for the
  same Member returns the first result, while a different fingerprint fails
  deterministically and both attempts remain auditable;
- concurrent membership, role, Ticket, and request changes fail closed on
  stale state;
- process A holds a session-scoped advisory Project lock while a database-only
  writer in process B attempts the same transaction-scoped advisory key and
  times out; a different-Project writer proceeds;
- backup, entitlement, membership, Ticket, Publish, and Accept paths all use the
  same canonical Project advisory-key implementation and fixed lock order;
- migration rollback or forward-recovery policy is exercised as applicable.

### 20.4 Git integration tests

- real bare repositories and real Git executables serve clone, fetch, and push;
- receive policy rejects protected, cross-Member, malformed, and stale ref
  changes;
- exact tree, blob, path, and repository limits are enforced;
- an external-profile Git child can see only its target repository, quarantine,
  explicit Git runtime, and no network or other Project path;
- a chunked oversized receive-pack, oversized blob, and projected repository
  quota breach are rejected through streamed reservations and quarantine checks
  before ref update;
- credentials and content never appear in process arguments or captured logs;
- cancellation, timeout, and shutdown reap every child;
- repository corruption and placement mismatch fail closed;
- delayed commands carrying an old placement generation cannot read or mutate
  after the applicable fence, including after old-node restart.

### 20.5 Cross-store fault injection

Every implemented cross-store workflow injects process failure after each of
its documented durable phases. The first slice covers Publish, Accept, and
development onboarding activation. Cloud-native creation, placement migration,
backup, and deletion join this gate only when their decision-complete phase
contracts enter the implementation sequence. Restart must either finish the
exact operation, return its idempotent result, clean invisible staging where
the accepted phase permits, or isolate the Project as recovery-required. No
test may infer completion from a missing file or an absent response.

A two-process recovery test kills process A after each durable phase and lets
process B immediately request another Project write. Process B must acquire the
write lock, recover or isolate the prior operation, and never admit the new
write past a non-terminal journal. Accept tests additionally prove that
protected main cannot move before the exact result OID is durable.

### 20.6 Capacity and restore gates

- exercise every §16 stage workload, including 500 registered Accounts for B
  test and the 1,000-Account/2,000-repository catalog for Post-Beta;
- record child CPU and memory rather than assuming a concurrency count;
- fill repositories with representative binary history as well as Markdown;
- verify disk headroom rejection before exhaustion;
- exercise the configured control, PostgreSQL transaction, pinned lease,
  recovery-reserve, Git, and event limits without connection starvation;
- replay the B-test and Post-Beta reconnect storms with jittered clients;
- restore PostgreSQL and repositories into a clean environment;
- verify Git integrity and representative control reads after restore;
- meet the staged RPO, RTO, volume, and quiescence objectives in §18;
- record latency and admission rejection against the provisional §16 gates and
  revise configuration when measurement disproves an assumption.

Shipped-entry tests also prove:

- `private-development` refuses every non-loopback bind;
- external profiles do not recognize the development Member assertion;
- production request-context binding rejects a missing or malformed
  `IngressPrincipal`;
- decoded client fields cannot populate or override the accepted ingress actor,
  device attribution, membership, role, entitlement, or placement;
- real Git Smart HTTP cannot bypass principal, Project admission, placement,
  generation fencing, write lease, streamed quota, or receive ref policy;
- membership revocation prevents every ingress context resolving through that
  membership, and a role change affects the next authorization check while
  deterministic same-intent replay remains available where policy permits;
- transport disconnect and forced shutdown eventually reap every Git child.

## 21. Initial implementation sequence

This is the critical path, not a parallel task assignment:

1. extract and version the canonical Cloud protocol package in `claudian`;
2. scaffold Node.js 24, strict TypeScript, configuration, safe logging, health,
   version, lifecycle, tests, and one composition root;
3. add PostgreSQL migrations, runtime/migration roles, Project isolation, and
   placement records, plus the canonical advisory Project lock and separate
   ordinary, pinned-lease, and reserved connection budgets;
4. add the bare repository authority, real Git integration, path containment,
   placement-lease generation checks, and bounded process supervision;
5. implement the private development bootstrap and restart recovery;
6. prove clone, fetch, personal-ref push, snapshot, and Project events;
7. implement Publish/request coordination and exact idempotency;
8. implement Accept with durable cross-store recovery and fault injection;
9. prove the two-device private-ingress scenario end to end;
10. select, make decision-complete, and implement at least one production
    Project creation path; define the trusted-ingress principal contract and
    stable Account/device/Project/membership identity, idempotency, and audit
    mappings, and remove the development actor assertion from every external
    profile;
11. integrate the external-Alpha trusted ingress and implement Project
    authorization, RLS, the target-repository-only Git sandbox, streamed quota
    enforcement, backup objectives, restore, retention, deletion, and
    operator-access gates before accepting external Project data;
12. when existing LAN Projects enter scope, complete the production authority
    handoff before enabling their onboarding.

Each phase exits only when its interface-level and real integration tests pass.
Later phases do not bypass missing recovery or isolation from earlier phases.

### 21.1 Steps 5–8 delivery gates and ownership

The local milestone advances through six ordered proof gates: `G5` bootstrap and persistent activation; `G6R` snapshot, events, upload-pack, and two-client binding; `G6W` personal-ref receive-pack; `G7` Requests, Tickets, comments, and Publish; `G8A` deterministic Accept and server recovery; and `GI` complete localhost integration. A changed contract, phase, owner, or capability reopens its gate and every dependent gate.

The mergeable PR order is fixed: Claudian protocol producer; Cloud exact protocol consumer; Cloud bootstrap; Claudian bootstrap; Cloud read plane; Claudian read/binding; Cloud personal write; Cloud collaboration; Claudian Publish; Cloud Accept; Claudian final integration. Every branch starts from the latest merged `origin/main`; Cloud never consumes unmerged Claudian source and capability advertisement occurs only after the complete server path and its gate evidence exist.

Schema evolution is one serial, checksum-verified lane: `0002_development_bootstrap.sql`, `0003_project_read_events.sql`, `0004_collaboration.sql`, then `0005_accept_recovery.sql`. The task that introduces each migration also owns its checksum/schema registry entry, least-privilege grants, forced-RLS policy, and real PostgreSQL evidence. Gates freeze that ordered catalog; they do not become a second migration owner.

Shared contract files, compatibility policy, and releases belong to the standalone protocol repository. Claudian and Cloud package manifests and lockfiles belong to their exact-consumer PRs; no later transport tranche edits those manifests opportunistically. The published `@claudian-collab/protocol` `1.0.0` registry artifact and lockfile integrity replace every local source, alias, or vendored-tarball path before the first Gomami deployment.

## 22. Explicit non-goals

- endpoint reachability, entry-access policy, caller login, credential issuance,
  or presented credential validation;
- per-Project virtual machines or persistent per-Project containers;
- Kubernetes, Redis, microservices, or active-active Git in the initial system;
- a separate Team, Organization, or generic Tenant product entity;
- shared Vault synchronization or arbitrary remote filesystem access;
- execution of provider-backed Agents in Cloud;
- ingestion of prompts, conversations, provider sessions, or credentials;
- real-time collaborative editing;
- user-managed server branch workflows;
- Git LFS, submodules, symlinks, or semantic binary merge in the initial
  product;
- synchronous payment-provider or Control Plane calls on ordinary collaboration
  traffic;
- treating infrastructure snapshots as verified application backups;
- production LAN-to-Cloud or Cloud-to-LAN cutover without a separately accepted
  authority-handoff protocol.

## 23. Risks and mitigations

| Risk | Mitigation |
| --- | --- |
| Cross-Project data leak from a missing filter | Project-scoped repositories, composite keys, RLS, two-Project escape tests |
| Split authority between LAN and Cloud | Manual LAN stop in private development; production cutover blocked on a complete handoff protocol |
| PostgreSQL/Git partial completion | Stable idempotency, expected OIDs, durable journals, Project write leases, restart fault injection |
| One Project monopolizes resources | Per-Project and global Git admission, bounded queues, quotas, timeouts, disk guards |
| Repository path escape | Opaque storage keys, placement-only lookup, real-path containment, no symlink roots |
| Git child compromise or runaway load | Unprivileged service, controlled environment, process limits, external-Alpha sandbox hardening |
| Control Plane outage blocks collaboration | Local membership and monotonic entitlement projections; ordinary traffic has no synchronous dependency |
| Direct backend access or forged ingress identity | Operator-owned ingress is the only supported external path; production deployment verification proves backend isolation and identity-channel protection |
| Single-node loss | Encrypted off-host backup, external recovery material, verified clean-environment restore |
| Scaling creates multiple Git writers | Placement leases and generations, required old-node fencing, Project write lease, CAS refs, and a fault-injected migration contract before enablement |
| Protocol drift between client and server | One versioned executable contract package and cross-repository contract fixtures |
| Telemetry leaks Project data | Explicit safe serializers, redaction tests, no bodies/content/credentials in logs or process arguments |
| Capacity estimate is mistaken | Alpha metrics, bounded admission, load tests, storage headroom, vertical scaling before sharding |

## 24. Blocking status

The foundation is implemented and the steps 5–8 local milestone is ready for producer-first implementation through the six gates in §21.1. Project mutation implementation must use the one canonical advisory-lock contract and fixed lock order in §11; repository interfaces must carry the placement lease and generation from their first implementation so sharding does not require a domain-API rewrite.

The following are intentionally deferred and do not block the private first
slice:

- the production trusted-ingress principal contract and stable mappings among
  Account, device attribution, Project, membership, and protocol actor identity;
- the production Project creation path selected for external Alpha;
- production LAN-to-Cloud cutover and client redirection;
- Cloud-to-LAN Host selection and authority handoff;
- Cloud Member Leave, last-Manager succession, and Project-wide Retire;
- exact commercial quotas, sponsorship limits, and read-only duration;
- final Cloud provider, region, and managed infrastructure products;
- final server license and supported self-host packaging.

Stable ingress-principal mappings and at least one production Project creation
path block every external Alpha. The production operator must provide caller
authentication, credential revocation, backend isolation, and identity-channel
protection outside Cloud Server. Cloud still requires membership and role
revocation behavior, final mutation revalidation, and auditable
Account/device/membership attribution. RLS, the target-repository Git sandbox,
streamed receive quotas, initial product quotas, verified backup objectives,
deletion recovery, and operator break-glass auditing block external Project
data. The full LAN-to-Cloud handoff blocks external onboarding of existing LAN
Projects. The self-host ingress contract, upgrade and migration process, and
backup/recovery packaging block supported self-hosting. Cloud Leave and Retire
block their corresponding user-visible operations. Placement migration remains
disabled until the generation-fence phases and stale-route fault tests pass.
None may be silently filled by private-development shortcuts.
