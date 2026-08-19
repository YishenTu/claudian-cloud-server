# Private Development Deployment

- Keep the operator-selected private ingress and its configuration on the host. Deployment artifacts expose only the Cloud Server loopback listener and must not configure endpoint access, caller authentication, or Project authorization.
- The Cloud Server container uses Linux host networking only to preserve the `private-development` profile's mandatory `127.0.0.1` bind. Do not add Compose port publication or broaden the application bind address.
- Runtime environment files live outside the checkout and image. Never copy `.env` files, SSH material, private-ingress state, or deployment credentials into the build context.
- Run the application as a numeric unprivileged user with a read-only root filesystem, dropped capabilities, bounded logs, and a stop grace period longer than the application shutdown timeout.
- Git-backed updates reject a dirty checkout, resolve one fetched commit, build an immutable revision-tagged image while the previous container remains available, and restore the previously observed image if the replacement does not become healthy. Git credentials and host-specific build-network configuration remain operator-owned state outside the repository.
- Add PostgreSQL and repository volumes only with the implementation that owns their lifecycle and restore contract; do not scaffold disposable storage that could become accidental authority.
- Verify the rendered Compose model, build the pinned image, exercise `/livez` and `/readyz` through the host loopback listener, and prove SIGTERM reaches bounded graceful shutdown.
