# Claudian Cloud Server Architecture

Status: roadmap Steps 1–10 and the mandatory pre-Step-11 gates are implemented and verified; the Step 11 portability and operational-durability contracts are accepted and ready for implementation.

Last reconciled: 2026-08-25

## 1. Purpose

Claudian Cloud Server is the public, auditable collaboration data plane for
Claudian Collab. It keeps canonical Git repositories and authoritative
coordination state available independently of any participant device.

This document defines the initial architecture, ownership boundaries,
multi-Project isolation model, storage contracts, concurrency and recovery
semantics, deployment shape, capacity target, and evolution path. It is
decision-complete for the implemented private Cloud slice and the accepted Step 11 authority-transfer, terminal-lifecycle, checkpoint, restore, deletion, schema-upgrade, and capacity target. Cloud-native Project and membership administration, ordinary-user UI, and final parity remain downstream. Trusted ingress and managed commercial systems remain outside this repository.

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
   and versioning are owned by `@claudian-collab/protocol`, produced from the
   standalone `claudian-collab-protocol` repository. This server implements
   that contract and does not copy it.
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
16. **Collab has three independent version authorities.** The implemented registry baseline is `@claudian-collab/protocol@3.2.1`, canonical wire version `6`, and Cloud binding version `2`, while Claudian LAN Project control remains independently at version `9`. No adapter infers compatibility from package SemVer alone or couples a Cloud change to the LAN binding.
17. **Durable phase records are singular authorities.** Activation, cancellation, client binding, and Accept each have one named journal or transition record. Membership, placement, repository directories, refs, indexes, and marker files are observations used to advance or reject that journal; none becomes a parallel phase authority.
18. **Authority generation fences authority movement.** Existing authorities begin at generation `1`; a supported transfer activates the target at exactly `source + 1`. Pre-cutover cancellation must prove the target has not accepted relinquishment. At or after the one-way source fence, every recovery owner moves forward and the source can never become writable again.
19. **One semantic checkpoint serves portability.** A versioned manifest, canonical logical coordination stream, and exact Git bundle share profile-specific allowlists for authority transfer, backup, and export. PostgreSQL rows, SQLite images, credentials, CA private keys, working trees, and operational refs are never the portable contract.
20. **Transfer claims bind existing identity only.** Presence never binds another Member. The transfer target initially binds only the source or selected target Host proven by the accepted transfer; every other imported active Member remains unbound until exact claim redemption. Claims cannot authenticate ingress, issue caller credentials, create membership, select role, or move a personal ref.
21. **Claim custody is recoverable without plaintext backup.** Cutover requires durable source custody of exactly one accepted raw claim-batch revision and exact target acknowledgement. Batch acknowledgement never scrubs. A revision may rotate only after authoritative proof that custody was not committed, and rotation atomically invalidates every older target hash. Per-Member scrubbing requires an exact target-signed redemption receipt forwarded by the same former Member. Cloud stores source-held raw claims as protected envelopes; backup contains ciphertext and public key references but no plaintext or private key.
22. **Environment restore is not Project recovery.** Project cross-store operations use the canonical Project lease and Project recovery catalog. Clean restore into empty stores uses one private environment journal and holds global readiness closed until every Project and terminal responder verifies.
23. **Operator access is not Project authorization.** Maintenance may resume only a deletion journal already created by Manager-authorized Retire or Cloud-to-LAN handoff. It cannot delete an active Project or create terminal intent.
24. **Schema upgrades are forward-only.** Each migration and its applied record commit in one transaction. A previous image may restart only before schema advancement or when it explicitly supports the advanced catalog; otherwise recovery is fixed-forward or a verified clean restore.

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

PostgreSQL Row-Level Security is mandatory defense in depth in every supported profile. Runtime transactions set a transaction-local Project context, and the runtime role remains subject to RLS. Migration and narrowly controlled offline repair roles are not used by ordinary request paths. RLS does not replace application authorization or composite constraints.

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

One dedicated recovery-candidate catalog schedules development activation, Accept, transfer, Leave, Retire, checkpoint, and deletion owners. A row contains only operation kind, opaque Project ID, opaque operation or attempt ID, and scheduling timestamps. Runtime enumeration is keyset-paged in stable order with at most 100 rows per page and cannot expose journal payload, membership, placement, report, Request, Ticket, claim, or checkpoint data. Every nonterminal Project journal updates its candidate in the same PostgreSQL transaction; terminal completion or cancellation removes it. A scanner must acquire the canonical Project advisory lock, enter forced-RLS Project scope, and re-read the full journal before dispatching the exact owner. Startup scanning improves latency, but every Project admission repeats this check under the same lock, so enumeration is never the correctness boundary. An unreadable catalog, unknown authority-volume identity, unknown operation kind, or unclassified candidate holds global readiness false; a classified `recovery-required` Project blocks only that Project.

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

Every supported self-host operation that parses participant-controlled Git input runs in a short-lived process sandbox or mount namespace. It can see only the target repository, an operation-specific quarantine or staging area, the required Git binaries and runtime libraries, and an empty explicit Git configuration. It has no network access and receives bounded CPU, memory, PID, filesystem, output, and duration budgets. This is per-operation containment, not a persistent container or VM per Project.

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

Git command execution remains internal to `GitRepositoryAuthority`. The isolated Git runner and a future routed worker implement this same deep boundary; neither creates a second domain API or exposes filesystem paths.

## 8. Protocol ownership and compatibility

The standalone `claudian-collab-protocol` repository produces `@claudian-collab/protocol`. The Cloud Server depends on the exact `3.2.1` npm registry release. That release carries canonical wire version `6`, Cloud binding version `2`, and backup coordination format version `2`; its npm lock entry records the immutable registry artifact integrity used by local development, CI, and deployments. Package SemVer, canonical wire version, Cloud binding version, backup coordination format version, and the independently owned LAN version are never substituted for one another.

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
explicit protocol-version policy whose canonical tests live in the standalone
protocol repository. Claudian and Cloud Server retain only consumer-conformance
fixtures against their exact registry dependency. The server never maintains a
second hand-written inventory of the same operations or validators.

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

This is an intentionally insecure actor assertion inside the operator's private development network. The deployment operator owns endpoint access; Cloud Server does not authenticate these development callers. The assertion is not recognized by self-hosted or managed profiles and is never a production identity mechanism.

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

This retained flow is development bootstrap only and is never called by production authority transfer. The accepted production LAN-to-Cloud checkpoint, source fence, claim-custody, relinquishment, activation, redirect, and recovery contract is §12.7.

### 12.5 Claudian local Cloud binding

Cloud activation does not wait for client-local state. Each client first persists a transition `intent` and keeps the former Host's non-restart fence active. Terminal binding begins only after Cloud snapshot and upload-pack are available, and each client repeats readiness immediately before changing local authority.

The one transition record advances through `intent`, `readiness-confirmed`, `origin-rotated`, `cloud-verified`, `membership-replaced`, `index-repaired`, `lan-authority-retired`, and `fence-terminal`. `membership-replaced` is the adapter-selection boundary: the strict tagged Cloud membership record becomes authoritative even if the derived Project index still needs repair. `lan-authority-retired` atomically moves only the former Host's exact inactive authority directory to an inert attempt-scoped private directory; the other client records a no-op. `fence-terminal` retains a terminal non-restart fence, recreates one Project work session from the Cloud record, and completes binding.

Recovery resumes from the durable phase plus exact observed URL, repository identity, membership, index, and retired-authority state. It never restores LAN authority after Cloud `activated`. The Cloud membership stores only canonical server URL, Cloud binding and wire versions, derived Git URL, and development actor ID; it stores no active LAN credential, CA, Host ownership, or duplicate recovery phase.

### 12.6 Production Project creation gate

Cloud-native Project creation and ordinary invitation/Join remain Step 12. They create new Project or membership authority and are not prerequisites for Step 11 transfer, which imports an already authorized Project and exact existing memberships. Transfer claims must never be reused as ordinary invitations.

A later Cloud-native design must keep the Project invisible until initial membership, coordination state, a validated bare repository, and active placement are recoverably bound. It must specify stable operation identity, request fingerprinting, activation ordering, abandoned-staging cleanup, idempotent replay, and failure recovery without inferring authority from directory presence.

### 12.7 Step 11 portability lifecycle

One Project checkpoint contains `checkpoint.json`, `coordination.ndjson`, and `repository.bundle`. The manifest binds profile, Project and operation identity, source authority kind/generation, exact sorted ref/OID inventory, expected main, artifact byte counts and SHA-256 digests, schema versions, and a canonical manifest digest. The initial ceilings are 64 KiB manifest, 256 MiB logical coordination, 1 GiB bundle, and 2 GiB staging reservation. Every stream is counted, digested, admitted, timed, cancellable, and cleanup-owned.

The portable coordination vocabulary contains Project identity, collaboration history, membership facts and roles, Requests, comments, Tickets, relations, mentions, stable IDs, revisions, and timestamps. It contains no SQL/SQLite representation, storage path, endpoint, ingress credential, LAN credential, invitation secret, CA private key, deployment secret, working tree, unpublished local state, cache, or operational journal. Transfer and export use the portable allowlist. Backup additionally includes Cloud operational continuity, terminal responders, protected claim envelopes, event/idempotency state, placement facts, tombstones, schema/build compatibility, and the authority-volume pair identity.

LAN-to-Cloud advances through:

| Phase | Durable authority meaning |
| --- | --- |
| `collecting-readiness` | An unused Project/transfer identity, exact target, source identity, requester, Host acceptance, and expiry are durable; LAN remains active and cancellation is allowed. |
| `source-quiesced` | LAN has drained and persistently fenced its write lane and every conflicting lifecycle owner; cancellation requires Cloud proof that relinquishment was not accepted. |
| `checkpoint-received` | Exact bounded source-signed artifacts are durable in isolated Cloud staging. |
| `checkpoint-validated` | Logical state, source trust, membership, limits, and Git refs/objects pass; target-native coordination, repository, Host proof, and non-Host claim hashes are inert. |
| `claims-retained` | The source Host durably holds the raw non-Host claim batch and Cloud durably returns the same receipt for the exact Host/transfer/intent/revision/digest after response loss or restart; revision or digest drift fails stale and an acknowledged batch is never rotated. |
| `repository-published` | The verified repository is atomically published at an inactive placement; ordinary Project admission remains absent. |
| `source-relinquished` | Cloud has verified the LAN Host's one-way certificate for the exact target, checkpoint, claim batch, and source generation; cancellation and LAN reopen are forbidden. |
| `cloud-activated` | One Project transaction activates exact membership and placement at `source generation + 1`, binds only the source Host principal, persists claims/result/events, and settles recovery. |
| `completed` | Attempt staging is removed while the former LAN authority retains only the authenticated terminal status and non-Host claim responder for at most 30 days. |

Cloud-to-LAN advances through:

| Phase | Durable authority meaning |
| --- | --- |
| `collecting-readiness` | Manager intent, selected active target Host, target acceptance, provisional LAN authority public proof, source generation, and expiry are durable; Cloud remains active. |
| `cloud-quiesced` | Cloud has drained and fenced the Project write lane and every conflicting journal. |
| `checkpoint-captured` | Cloud has captured and verified the exact portable checkpoint. |
| `target-staged` | The selected target has imported inert LAN-native state, verified Git, bound only its own locally generated credential, installed exactly one current revision of non-Host claim hashes, and reported the exact stage/revision/batch digest. |
| `claims-retained` | Cloud has sealed and durably retained the raw non-Host claims for the exact current revision/digest and returned the replayable custody receipt; an acknowledged revision is never rotated. |
| `cloud-relinquished` | Cloud has denied active admission and committed the replayable one-way handoff result; Cloud can never reopen this generation. |
| `lan-activated` | The target has observed exact Cloud relinquishment and atomically activated LAN at `source generation + 1`. |
| `completed` | One Project transaction makes the transfer result terminal and creates the authorized deletion journal already at `traffic-denied`; the authenticated terminal responder, protected unclaimed claims, and tombstone remain for at most 30 days while deletion recovery proceeds independently. |

Each transfer has one monotonic `claimBatchRevision`, beginning at `1`, bound to Project, transfer, checkpoint, target generation, complete Member set, and batch digest. A party missing the custody response must first replay or query the exact revision/digest. If custody committed, the exact same receipt is returned through restart and rotation is forbidden. Only an authoritative target/source response proving that revision was not committed permits the batch generator to increment the revision. That target transaction atomically replaces every unredeemed claim hash, records permanent invalidation of all older revisions, and binds the new complete digest; the source replaces any uncommitted raw candidate before acknowledging. Delayed reports, batches, acknowledgements, claims, or receipts for an older revision fail stale. Timeout, disconnect, or missing local state alone never permits rotation. Fault recovery and reordering therefore leave at most one redeemable batch revision.

Before either source-relinquishment phase, both directions cancel through the same semantic settlement:

| Phase | Durable authority meaning |
| --- | --- |
| `cancel-intent` | The source records cancellation while remaining active or quiesced at its existing generation, freezes further transfer progress, and requests exact target invalidation; source writes cannot reopen from quiescence yet. |
| `target-invalidated` | The target durably proves it has not accepted source relinquishment and fences the exact transfer/checkpoint/generation so delayed messages can never activate it. An unreachable, contradictory, or ambiguous target leaves cancellation pending and the source fenced. |
| `target-cleaned` | The target removes only exact attempt-owned logical state, claim hashes, artifact staging, and inactive repository placement under the invalidation proof; source-held raw claims are marked unusable. |
| `source-reopened` | The source verifies the exact target invalidation/cleanup result, scrubs its cancelled claim batch, clears only this transfer fence, and resumes the same source generation with already-settled invitation/Join state. |
| `cancelled` | The stable terminal cancellation result is replayable and recovery candidates plus remaining attempt-only state are removed. |

Cancellation may start after any pre-relinquishment transfer phase, including after claim custody or inactive repository publication. No directory absence, disconnect, timeout, or unverified remote response permits source reopen. At or after `source-relinquished` or `cloud-relinquished`, cancellation is rejected and every source/target recovery path moves forward to target activation, terminal response, and any authorized deletion handoff.

Socket presence and events are latency hints, never consent or identity proof. LAN-to-Cloud activation binds only the source Host through source proof. Cloud-to-LAN staging binds only the selected target Host. Every other active Member remains imported and unbound. The old authority authenticates a former Member and returns only that Member's retained opaque claim. Cloud redemption binds the exact accepted ingress principal; LAN redemption binds the claimant's already persisted client-generated credential hash. Exact retries return the same target-signed receipt. The same former Member forwards that receipt through the old binding; only that receipt or expiry scrubs the source-held claim. Batch custody acknowledgement never scrubs.

Leave settlement advances `prepared -> membership-left -> personal-ref-removed -> completed`. The membership transaction revokes ordinary admission/principal mapping, discards the open Request according to LAN parity, removes structured mentions, emits the redacted event, and atomically creates one bounded former-principal replay record bound to exact trusted principal, Project, Member, Leave intent/fingerprint, and journal. That record permits only recovery and replay of this Leave; it grants no Project read, write, Git, event, role, or membership authority. Repository Authority then removes only the exact expected-OID personal ref, and completion stores the stable terminal result in the same replay record for 30 days. A lost response at any phase lets only that accepted former principal reacquire the canonical Project lane, finish recovery, and receive the exact result; unrelated principals and changed fingerprints fail closed. Last-Manager Leave fails with `manager-succession-required`; the public succession-aware operation remains Step 12.

Manager-authorized Retire uses one Project transaction to persist the terminal response, former-principal acknowledgement map, expiry, content-free tombstone shell, terminal Retire result, service state `deleting`, and a deletion journal already at `traffic-denied`. Cloud-to-LAN uses the same atomic journal handoff when the transfer becomes `completed`. In either path the source operation is terminal before deletion is the sole nonterminal recovery candidate; there is no crash gap and no Project has two nonterminal journals.

Generic deletion advances through:

| Phase | Durable authority meaning |
| --- | --- |
| `traffic-denied` | Ordinary control, Git, event, and maintenance admission is closed; the authorized source operation is terminal; the deletion journal/candidate, terminal result/responder, acknowledgement map and expiry, protected unclaimed claims where applicable, and content-free tombstone shell are durable in the minimal non-content coordination partition. |
| `repository-delete-intent` | Exact Project, placement/storage identity and generation, repository identity, deletion reason, and expected state are frozen before Repository Authority may detach or remove anything. |
| `repository-removed` | Repository Authority has removed only that exact repository. Missing-after-intent is replay success; absence or mismatch before intent is never authorization or proof. |
| `coordination-removed` | Project content, memberships, principal mappings, placements, and superseded operational rows are removed. The same deletion journal and recovery-candidate row, terminal responder/result, acknowledgement map, protected unclaimed claims, and tombstone shell remain addressable by the same Project ID, lock key, forced-RLS context, and mixed dispatcher. |
| `tombstoned` | Phase CAS verifies repository and Project content absence, seals the existing tombstone shell with the exact terminal result digest, and proves only the allowlisted non-content continuity rows remain. It does not create a second tombstone or catalog. |
| `completed` | The deletion journal is terminal and exact replayable result remains; the recovery candidate is removed. The responder/acknowledgement/claim rows expire after all acknowledgements or 30 days, while the minimum tombstone and terminal journal identity remain. |

The minimal non-content partition is part of the one coordination contract, not a second recovery registry. Operator `resume-delete` can continue only the exact nonterminal journal identity/digest and returns the same result when it is terminal; it cannot create deletion intent. Process death after any phase, including immediately after `coordination-removed`, re-enters the same Project lock and journal and never restores active state.

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
- `deleted`: Project content and repository are absent; only the allowlisted non-content tombstone and terminal journal/result remain, plus a time-bounded responder/acknowledgement/claim set where the terminal lifecycle requires it.

Onboarding staging is not a Project authority state and cannot serve traffic.
A Project becomes durable only after activation.

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

Step 11 implements authority transfer, internal Leave settlement, Manager-authorized Retire, terminal response, and generic deletion under the lifecycle contracts in §12.7. It does not reuse the physical LAN `HostTransferPackage` or make LAN retirement routes into Cloud routes. Leave is not advertised as a public Step 11 capability because last-Manager succession and ordinary membership administration remain Step 12. Claudian ordinary-user entry remains Step 13.

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

### 15.1 Private development and supported self-host

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

### 15.2 Supported self-host hardening

The deployment operator owns TLS, endpoint reachability, caller authentication, credential issuance and validation, and the trusted-ingress principal boundary. A supported self-host deployment maps that operator-protected entry to the loopback Cloud service and preserves direct-backend isolation; Cloud Server does not implement a second ingress or Account system.

Cloud Server owns runtime roles and RLS, target-repository-only Git execution, streamed Project and global reservations, quarantine and reachable-repository quotas, read-only container filesystems except explicit state mounts, safe telemetry, lifecycle recovery, verified application backup and restore, exact deletion, and cross-Project isolation. Authority transfer is admitted only after its checkpoint, source-fence, target-generation, and restart proofs pass. These data-plane guarantees are identical behind private Tailscale access and any operator-selected ingress.

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
short-lived Git sandbox is an internal execution control and
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

A backup record binds the database schema/build catalog, authority-volume identity, exact Project checkpoint inventory, Project authority and placement generations, lifecycle and terminal-responder continuity, protected claim-envelope inventory, tombstones, artifact digests, capture time, verification status, and retention class. It never contains raw claim plaintext, private receipt keys, or the claim-custody keyring.

Cross-store backup does not claim impossible atomicity. For every changed Project, the maintenance command acquires the canonical Project write lease, resolves non-terminal journals, durably enters maintenance, captures the logical coordination snapshot in one repeatable transaction, captures the exact allowed Git refs and self-contained bundle while writes remain fenced, verifies the common manifest and both artifacts, publishes the immutable local checkpoint/catalog record, and reopens the Project. PostgreSQL transactions are not held during Git capture. Failed or cancelled attempts never publish a checkpoint and recovery cleans or resumes only exact operation-owned staging. A terminal Project journal and `published` checkpoint result mean only that local capture/publication settled; neither is a completed or restore-verified backup.

Backup and export use one profile-bound Project checkpoint journal:

| Phase | Durable authority meaning |
| --- | --- |
| `prepared` | Project, operation, profile, authority/placement generation, expected service state, staging reservation, and manifest version are frozen; maintenance state fences new writes and every earlier journal is terminal. |
| `coordination-captured` | The exact canonical logical stream and its schema/version/digest facts are durable in operation-owned staging. |
| `repository-captured` | The exact allowed ref/OID inventory and self-contained Git bundle from the same fenced generation are durable. |
| `checkpoint-verified` | Both artifacts, canonical manifest, limits, digests, ref reachability, portable trees, and strict Git integrity pass. |
| `artifact-published` | Backup has atomically published an immutable local checkpoint/catalog entry, or export has published one bounded operation-owned delivery artifact; Project writes remain fenced while recovery becomes forward-only. |
| `completed` | Capture staging is removed and one Project transaction clears maintenance, terminalizes the journal, removes its recovery candidate, and reopens writes. The immutable backup checkpoint or bounded export-delivery artifact remains under its distinct catalog/TTL owner. |

Before `artifact-published`, cancellation advances through `cancel-intent -> cancelled`: `cancel-intent` freezes capture/delivery, exact operation-owned staging is removed, maintenance state is cleared, and writes reopen only after cleanup is proven. Contradictory ownership or ambiguous cleanup becomes `recovery-required`. At or after `artifact-published`, Project recovery completes forward through `completed` before new writes. Export publication remains recovery-readable under its retained storage identity while a separate durable marker binds the external delivery TTL. Due cleanup re-enters the Project lane and retains every nonterminal journal; a matching completed export or Project tombstone permits exact artifact removal after restart. Export streaming or operator-path delivery begins only from the terminal cataloged artifact; disconnect, success, cancellation, and TTL cleanup belong to that non-authoritative artifact owner and cannot affect Project authority or canonical storage.

Backup scheduling prioritizes Projects changed since their newest verified
checkpoint and runs a bounded number of different Projects concurrently. All
Git verification children share the ordinary global child budget. The fleet
checkpoint window must finish within half the active backup interval. A single
Project checkpoint starts with a p95 write-quiescence objective of 60 seconds
and a hard attempt budget of five minutes; exceeding the budget aborts and
retries rather than silently blocking Project writes. Repeated misses require
incremental, deduplicated, or snapshot-capable storage before advancing the
stage.

The common manifest is the §12.7 semantic checkpoint with the `backup` profile. An environment backup catalog additionally binds every Project checkpoint, schema/build compatibility, database/volume pair identity, and operator-verifiable completion. A backup becomes verified only after an isolated clean restore opens every live protected claim envelope using the separately supplied keyring, passes database and Git integrity, and completes representative Project plus terminal-responder reads. Operator scheduling, whole-artifact encryption, off-host transport, destination, retention, and key distribution remain outside runtime.

Export invokes the same checkpoint coordinator with the `export` profile. It contains only the portable Project repository and coordination records, excludes Cloud operational continuity and credentials, and never deletes or transfers the authority. Capture briefly fences writes through checkpoint completion; the separate bounded delivery artifact is removed after successful delivery, delivery cancellation, or expiry.

Clean restore is supported only with Cloud Server stopped, readiness closed, an empty PostgreSQL target, and an empty authority volume. `EnvironmentRestoreCoordinator`, not Project recovery, owns the private database/volume-paired journal `validated -> database-created -> coordination-imported -> repositories-staged -> pair-prepared -> repositories-published -> authority-published -> verified -> completed`. It validates the full catalog before creating target state, imports every Project without admission, increments restored placement generations, preserves event/idempotency and terminal continuity, and verifies exact refs/objects plus representative reads before readiness opens. Before `authority-published`, unambiguous failure may remove only exact restore-owned state. At or after publication, recovery is forward-only. The operator must independently fence the old authority before directing ingress to the restored environment.

The deployment operator mounts the claim-custody encryption and receipt-signing keyring read-only at `/run/secrets/claudian_claim_custody_keyring`, owned by runtime UID/GID `10001:10001` with exact mode `0400`. Server, `backup`, `verify-backup`, `restore`, and `verify-authority` profiles receive the mount while remaining unprivileged; migration, export, `resume-delete`, and unrelated profiles do not. Preflight rejects symlinks, non-regular files, wrong ownership/mode, malformed or missing keys, and reports only a sanitized code. Referenced historical keys remain available out of band with the backup.

Deletion is the idempotent journal in §12.7. Participant-local copies are never deleted by Cloud. Partial deletion never restores active admission, recreates a removed repository, infers authorization from path absence, or loses replay evidence. Operator `resume-delete` must present the exact identity and digest of an existing Manager-authorized Retire or Cloud-to-LAN deletion journal; operator access cannot create terminal intent.

## 19. Lifecycle and shutdown

### 19.1 Startup

1. decode and validate configuration without logging secrets;
2. enforce deployment-profile safety constraints;
3. initialize safe logging and process-level failure handling;
4. validate the exact claim-custody keyring path, type, owner, mode, and referenced keys when the selected profile serves protected claims;
5. connect with the runtime PostgreSQL role, verify the declared schema interval, and reconcile the database/authority-volume identity;
6. recover or reject the private environment-restore journal while global readiness remains closed;
7. verify repository root ownership, containment, capacity, Git version, and
   required capabilities;
8. inspect and schedule Project-scoped durable operation recovery;
9. mark only unreconciled Projects as recovery-required when isolation is safe;
10. enumerate the bounded active-placement and terminal-responder catalogs, re-enter each Project under its canonical lock, and verify authority generation, live Git integrity, exact allowed refs, tombstones, and protected-claim continuity;
11. start HTTP admission and publish readiness.

Production schema migration is a separate one-shot command using the migration role and one global advisory lock. Each checksum-pinned migration body plus applied record commits in one transaction; gaps, drift, unsupported versions, and nontransactional statements fail closed. The supported deployment sequence verifies the candidate, drains and stops runtime, verifies a pre-upgrade backup, preflights compatibility, migrates once, starts the candidate, and waits for recovery/integrity/readiness. Previous-image restart is permitted only before schema advancement or when that image explicitly supports the advanced catalog; otherwise recovery is fixed-forward or a verified clean restore.

### 19.2 Shutdown

1. mark readiness false;
2. stop new control, Git, event, and onboarding admission;
3. close event subscription, transfer-stream, terminal, and maintenance admission and notify clients to reconnect where possible;
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

Every implemented cross-store workflow injects process failure after each documented durable phase. Step 11 adds LAN-to-Cloud, Cloud-to-LAN, Leave ref settlement, Retire/deletion, backup/export checkpointing, and clean environment restore to the existing Publish, Accept, and development-activation lanes. Restart must finish the exact forward path, return its idempotent result, clean exact invisible staging only where the accepted phase permits, or isolate the Project/environment with readiness closed. No test may infer completion, authorization, or identity from a missing file or absent response.

A two-process recovery test kills process A after each Project phase and lets process B request another write. Process B must acquire the canonical lock, recover or isolate the prior operation, and never admit the new write past a non-terminal journal. Transfer tests additionally prove source generation can never reopen after relinquishment, batch custody acknowledgement cannot scrub, exact redemption receipt forwarding can scrub only one former Member's source claim, and neither direction creates two writers. Environment-restore tests use empty multi-Project stores, kill after every environment phase, and prove database/volume pair ambiguity keeps global readiness closed.

### 20.6 Capacity and restore gates

- exercise every §16 stage workload, including 500 registered Accounts for B
  test and the 1,000-Account/2,000-repository catalog for Post-Beta;
- record child CPU and memory rather than assuming a concurrency count;
- fill repositories with representative binary history as well as Markdown;
- verify disk headroom rejection before exhaustion;
- exercise the configured control, PostgreSQL transaction, pinned lease,
  recovery-reserve, Git, and event limits without connection starvation;
- replay the B-test and Post-Beta reconnect storms with jittered clients;
- restore PostgreSQL and repositories into a clean environment through the private environment journal;
- verify Git integrity, event/idempotency continuity, protected claim redemption, terminal response, and representative control reads after restore;
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
- transport disconnect and forced shutdown eventually reap every Git child and checkpoint stream;
- `resume-delete` rejects active Projects and any request without the exact existing Project-authorized deletion journal;
- schema crash tests cover before, during, and after advancement and never restart an incompatible previous image.

## 21. Completed local sequence and remaining rollout

The local milestone followed this critical path:

1. scaffold Node.js 24, strict TypeScript, configuration, safe logging, health,
   version, lifecycle, tests, and one composition root;
2. add PostgreSQL migrations, runtime/migration roles, Project isolation, and
   placement records, plus the canonical advisory Project lock and separate
   ordinary, pinned-lease, and reserved connection budgets;
3. add the bare repository authority, real Git integration, path containment,
   placement-lease generation checks, and bounded process supervision;
4. implement the private development bootstrap and restart recovery;
5. prove clone, fetch, personal-ref push, snapshot, and Project events;
6. implement Publish/request coordination and exact idempotency;
7. implement Accept with durable cross-store recovery and fault injection;
8. prove the complete Claudian-to-Cloud localhost scenario.

After that milestone, the protocol ownership migration published the canonical package from the standalone `claudian-collab-protocol` repository and moved both consumers to exact `@claudian-collab/protocol@1.0.0`. The private Gomami proof then completed roadmap Step 9, including the real two-Mac gate, and the private multi-Project hardening completed Step 10. External-user rollout, managed Account systems, and operator authentication implementation are outside this project's roadmap.

Before Step 11, one mandatory readiness gate repairs the production Obsidian Cloud HTTP path and converges Project Management ownership. Claudian must use a CORS-independent desktop transport behind its Cloud adapter instead of requiring the Cloud Server or operator ingress to grant browser-origin access. Transport-neutral Project-management names, DTOs, codecs, safe errors, limits, capability identifiers, and fixtures belong to the standalone protocol package; Claudian owns one authority-neutral application port with LAN and Cloud adapters; each authority retains its state, authorization, credentials, routes, and durable lifecycle execution.

The remaining numbered roadmap sequence is:

11. implement supported LAN-to-Cloud and Cloud-to-LAN authority transfer, Cloud Leave and Retire authority semantics, upgrade and schema migration, backup, verified clean restore, export, deletion, and measured capacity;
12. implement Cloud-native Project creation, invitation, Join, post-activation membership, role administration, last-Manager succession, personal-ref establishment, and ordinary Leave;
13. expose the accepted Cloud lifecycle through Claudian's capability-gated ordinary-user UI and recovery paths; and
14. prove complete LAN/Cloud semantic parity and the reproducible self-host delivery with the production Claudian UI and retained two-Mac Gomami environment.

Each phase exits only when its interface-level and real integration tests pass.
Later phases do not bypass missing recovery or isolation from earlier phases.

### 21.1 Steps 5–8 delivery gates and ownership

The local milestone advanced through six ordered proof gates: `G5` bootstrap and persistent activation; `G6R` snapshot, events, upload-pack, and two-client binding; `G6W` personal-ref receive-pack; `G7` Requests, Tickets, comments, and Publish; `G8A` deterministic Accept and server recovery; and `GI` complete localhost integration. A changed contract, phase, owner, or capability reopens its gate and every dependent gate.

The completed local-milestone merge order was: the original shared protocol producer in Claudian; Cloud foundation; the original Cloud protocol consumer; Cloud bootstrap; Claudian bootstrap; Cloud read plane; Claudian read/binding; Cloud personal write; Cloud collaboration; Claudian Publish; Cloud Accept; and Claudian final integration. After `GI`, the separate ownership migration published the standalone protocol release and converted Claudian and Cloud into exact registry consumers. Steps 9 and 10 then passed on the merged exact consumers. Every future branch starts from the latest merged `origin/main`; neither consumer uses unmerged protocol source, and capability advertisement occurs only after the complete authority path and its gate evidence exist.

Schema evolution is one serial, checksum-verified lane: `0002_development_bootstrap.sql`, `0003_project_read_events.sql`, `0004_collaboration.sql`, `0005_accept_recovery.sql`, then Step 11 `0006_portability_lifecycle.sql`. The task that introduces each migration also owns its checksum/schema registry entry, least-privilege grants, forced-RLS policy, and real PostgreSQL evidence. Gates freeze that ordered catalog; they do not become a second migration owner.

Shared contract files, compatibility policy, and releases belong to the standalone protocol repository. Claudian and Cloud own their consumer package manifests and lockfiles; no later transport tranche edits those manifests opportunistically. Published `3.2.1` is the implemented baseline. Step 11 followed a producer-first order: exact `@claudian-collab/protocol@3.2.1` with wire v6, Cloud binding v2, and backup coordination format v2 was published and independently verified before Cloud pinned it for O1. The exact pin alone advertises nothing; each new capability is advertised only after its complete server and client path passes.

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
- authority movement without the accepted checkpoint, generation fence,
  relinquishment, claim-custody, and target-activation contracts.

## 23. Risks and mitigations

| Risk | Mitigation |
| --- | --- |
| Cross-Project data leak from a missing filter | Project-scoped repositories, composite keys, RLS, two-Project escape tests |
| Split authority between LAN and Cloud | Source quiescence, one-way relinquishment, exact `source + 1` target generation, forward-only recovery, and fault injection after every durable phase |
| PostgreSQL/Git partial completion | Stable idempotency, expected OIDs, durable journals, Project write leases, restart fault injection |
| One Project monopolizes resources | Per-Project and global Git admission, bounded queues, quotas, timeouts, disk guards |
| Repository path escape | Opaque storage keys, placement-only lookup, real-path containment, no symlink roots |
| Git child compromise or runaway load | Unprivileged service, controlled environment, process limits, target-repository sandboxing, and streamed quotas |
| Control Plane outage blocks collaboration | Local membership and monotonic entitlement projections; ordinary traffic has no synchronous dependency |
| Direct backend access or forged ingress identity | Operator-owned ingress is the only supported external path; production deployment verification proves backend isolation and identity-channel protection |
| Single-node loss | Encrypted off-host backup, external recovery material, verified clean-environment restore |
| Scaling creates multiple Git writers | Placement leases and generations, required old-node fencing, Project write lease, CAS refs, and a fault-injected migration contract before enablement |
| Protocol drift between client and server | One versioned executable contract package and cross-repository contract fixtures |
| Telemetry leaks Project data | Explicit safe serializers, redaction tests, no bodies/content/credentials in logs or process arguments |
| Capacity estimate is mistaken | Isolated workload metrics, bounded admission, load tests, storage headroom, vertical scaling before sharding |

## 24. Blocking status

The foundation, steps 5–8 local milestone, standalone `@claudian-collab/protocol@1.0.0` release, Step 9 private Gomami proof, real two-Mac convergence proof, and Step 10 private multi-Project hardening are complete. Project mutations continue to use the one canonical advisory-lock contract and fixed lock order in §11; repository interfaces carry the placement lease and generation so future sharding does not require a domain-API rewrite.

A production Obsidian smoke check found and the pre-Step-11 gate repaired a client-composition regression: Claudian now uses a CORS-independent desktop transport behind its Cloud adapter and keeps the Cloud endpoint non-browser. The same gate established the standalone shared Project Management contract and one authority-neutral Claudian application port. Installed Obsidian, LAN, Cloud, bundle-size, and exact-package checks passed before Step 11 planning.

No unresolved in-scope product or architecture decision blocks Step 11 implementation. Step 11 now follows the accepted producer-first protocol, storage/lifecycle foundation, authority movement, operational durability, local evidence, isolated Gomami evidence, and closure gates. Cloud-native Project and membership lifecycle remains Step 12, ordinary-user Claudian entry remains Step 13, and the full LAN/Cloud parity and delivery matrix remains Step 14. Placement migration remains disabled until measured need and a separate generation-fence design justify it.

Caller authentication, credential issuance and validation, TLS, direct-backend prevention, public ingress, managed Accounts, billing, entitlement, commercial quotas, external users, managed infrastructure selection, and managed operator procedures remain deployment-operator or separate product-program concerns rather than blockers owned by this repository.
