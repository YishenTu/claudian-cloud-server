# Server transports

- All Project JSON, Git, event, lifecycle, and artifact requests enter through the same request-context binding. Health and capability discovery remain principal-free and must not expose Project existence or recovery details.
- Decode and dispatch the canonical protocol through its package-owned registry. Do not register LAN-source-only proposal or Host-acceptance operations on the Cloud binding, or probe multiple mutation owners to infer transfer direction.
- Server code never issues SQL, resolves repository storage paths, invokes raw Git, or interprets lifecycle journals. Authority-transfer dispatch and Project authorization remain behind their owners.
- Preserve negative-settlement evidence only from the authority-owned `ProjectMutationRejection`. HTTP status, error codes, diagnostics, or request contents cannot prove that an ambiguous mutation had no effect.
- Durable Project events are the source of invalidation history; process-local notifications only wake readers.
- Stream cancellation includes rejected uploads and download streams that arrive after cancellation. Close incomplete rejected uploads and destroy every stream the transport cannot consume; preserve bounded streaming and package-owned artifact headers.
