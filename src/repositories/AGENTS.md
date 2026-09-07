# Repository authority

- Canonical repository paths and Git execution belong here. Callers provide server-derived placement/storage identities, not raw canonical paths. Validate generation and placement before execution and again before mutation.
- User-controlled names cannot form paths. Enforce normalized and real-path containment, reject symlink roots/entries, and keep hooks, executable selection, and Git configuration server-owned.
- Atomic staging publication depends on sibling directories on one authority filesystem. Validation markers identify ownership; they never replace live Git integrity checks or the Project journal's activation/cancellation authority.
- Event invalidation verifies live placement, containment, bare-repository shape, and exact refs/main, without scanning the full object graph. Latent object corruption is detected by the next full integrity boundary: snapshot/content admission, mutation, startup, import/restore, or backup verification. Preserve those full checks and never substitute a retained healthy marker.
- Creation replay may complete an exact partial repository but must fail on divergent objects, refs, markers, or storage identity without overwriting or deleting it.
- Repository reservation capabilities are Project-scoped. Consume the caller's existing reservation for lifecycle effects; do not reacquire capacity inside its Project lease.
- Join creates only its persisted personal ref at the pinned main OID with missing-ref CAS. Removal/Leave delete only the persisted ref at its expected OID; unrelated ref changes remain failures.
- Export only protected main and retained Member refs from the exact logical snapshot. Do not use `--all` or include operational, validation, backup, temporary, or replace refs.
- Import verifies digests, exact refs/OIDs, reachable portable trees, quota, and Git integrity before inactive publication. Checkpoint stream disposal belongs to the stream owner even when verified replay stops consuming input early.
- Deletion targets only the frozen authorized storage identity. Absence after durable deletion intent can establish replay; absence before intent cannot authorize deletion.
- Keep receive-pack quarantine, full reachable-tree checks, expected-OID CAS, and projected quotas around Git effects. Accept constructs and verifies its deterministic commit without checkout or ambient Git configuration before exposing the result OID.
- All Git process paths use the controlled environment and bounded supervisor, including validation and maintenance. Terminate and reap the process group and settle its streams before releasing resources. A shared service container or controlled Git environment does not establish per-Project OS or network isolation.
