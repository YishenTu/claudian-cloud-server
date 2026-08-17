# Repository authority

## Placement and paths

- This is the only scope that resolves repository storage keys into paths or
  starts Git processes. Callers pass a server-derived placement lease containing
  Project, node, opaque storage key, and generation; they never pass raw paths.
- Validate placement state and generation before execution and again before a
  mutation. Stale generations, wrong nodes, maintenance state, or unavailable
  fence authority fail closed.
- User-controlled names never form paths. Enforce normalized and real-path
  containment, no symlink roots or repository entries, and server-owned hooks
  and configuration.

## Git execution

- Enforce exact allowed refs, expected-OID CAS, full reachable-tree policy,
  streamed pack reservations, quarantine inspection, projected repository
  quotas, and cleanup on success, rejection, cancellation, timeout, and
  shutdown.
- Participant-controlled Git input in external profiles runs in a short-lived
  target-repository-only sandbox with no network and bounded CPU, RSS, PIDs,
  filesystem, output, and duration. This is not a persistent per-Project
  container or VM.
- Count Smart HTTP, validation, Accept, maintenance, and backup verification
  processes against the shared child budget owned by resource admission.
- Keep local execution, the sandbox, and a future routed worker behind one deep
  repository authority. Do not expose a second domain API or remote-node port
  before a second implementation actually exists.

## Verification

- Use real bare repositories and Git executables for path escape, ref policy,
  stale generation, quota, binary history, cancellation, process cleanup,
  corruption, and sandbox visibility tests.
