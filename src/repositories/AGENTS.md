# Repository authority

## Placement and paths

- This is the only scope that resolves repository storage keys into paths or starts Git processes. Callers pass a server-derived placement lease containing Project, node, opaque storage key, and generation; they never pass raw paths.
- Validate placement state and generation before execution and again before a mutation. Stale generations, wrong nodes, maintenance state, or unavailable fence authority fail closed.
- User-controlled names never form paths. Enforce normalized and real-path containment, no symlink roots or repository entries, and server-owned hooks and configuration.
- Development staging and canonical repositories are sibling paths on one authority filesystem. Publication requires an exact validation marker, live object-format/ref/OID/integrity verification, and one atomic rename; repository presence or absence never decides activation, cancellation, or recovery without the Project-authority journal.
- Startup revalidates every active catalog placement under its Project lock and requires exact protected main plus active-member branch refs before readiness. Marker files never substitute for live Git verification.
- Project checkpoint export includes only protected main and retained Member refs from the exact quiesced logical snapshot. It never uses unreviewed `--all`; operational, validation, temporary, backup, and replace refs remain excluded.
- Checkpoint import verifies manifest/artifact digests, `git bundle verify`, exact refs/OIDs, reachable objects, portable trees, projected quota, and strict `fsck` before inactive publication. Restore staging and authority-transfer staging never become ordinary placements by filesystem observation.
- Exact deletion resolves only the placement/storage identity frozen in the authorized journal. Missing-after-intent may be replay success; absence before intent never authorizes or proves deletion.

## Git execution

- Enforce exact allowed refs, expected-OID CAS, full reachable-tree policy, streamed pack reservations, quarantine inspection, projected repository quotas, and cleanup on success, rejection, cancellation, timeout, and shutdown.
- Participant-controlled Git input in external profiles runs in a short-lived target-repository-only sandbox with no network and bounded CPU, RSS, PIDs, filesystem, output, and duration. This is not a persistent per-Project container or VM.
- Count Smart HTTP, validation, Accept, maintenance, and backup verification processes against the shared child budget owned by resource admission.
- Exact lifecycle ref verification/removal and repository verification/removal require one opaque Project-scoped repository reservation acquired before the caller's canonical Project lease. Repository operations validate and consume that reservation without acquiring capacity from inside the lease.
- Keep local execution, the sandbox, and a future routed worker behind one deep repository authority. Do not expose a second domain API or remote-node port before a second implementation actually exists.
- Accept creates its persisted deterministic commit plan without checkout or ambient Git configuration, parses the object back, and returns a verified result OID before Project authority may compare-and-swap protected main.

## Verification

- Use real bare repositories and Git executables for path escape, ref policy, stale generation, quota, binary history, cancellation, process cleanup, corruption, and sandbox visibility tests.
