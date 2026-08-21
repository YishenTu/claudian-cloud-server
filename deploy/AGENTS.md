# Deployment

- Keep one shared deployment artifact set for the Cloud Server implementation. Do not copy deployment files into `private-development`, `self-hosted`, or `managed` variants; split this scope only when deployment mechanics genuinely differ.
- Keep the operator-selected ingress and its configuration on the host. Deployment artifacts must not configure endpoint access, caller authentication, or Project authorization.
- The Compose topology uses Linux host networking so a configured loopback listener remains on host loopback. Do not add Compose port publication or broaden the application bind address in deployment artifacts.
- Runtime environment files live outside the checkout and image. Never copy `.env` files, SSH material, private-ingress state, or deployment credentials into the build context.
- Run the application as a numeric unprivileged user with a read-only root filesystem, dropped capabilities, bounded logs, and a stop grace period longer than the application shutdown timeout.
- Git-backed updates reject a dirty checkout, resolve one fetched commit, build an immutable revision-tagged image while the previous container remains available, and restore the previously observed image if the replacement does not become healthy. Git credentials and host-specific build-network configuration remain operator-owned state outside the repository.
- Add PostgreSQL and repository volumes only with the implementation that owns their lifecycle and restore contract; do not scaffold disposable storage that could become accidental authority.
- For the local milestone, PostgreSQL 18 by digest and the Cloud authority volume are a paired persistent restart unit. Fresh-volume provisioning is an explicit operator sequence: start PostgreSQL, run the bootstrap-role one-shot service, run the migration-role one-shot service, then start the runtime with runtime credentials only. The runtime never receives bootstrap/migration credentials or applies schema.
- Verify the rendered Compose model, build the pinned image, exercise `/livez` and `/readyz` through the host loopback listener, and prove SIGTERM reaches bounded graceful shutdown.
