# Claudian Cloud Server

Claudian Cloud Server is the public, auditable collaboration data plane for Claudian Collab. It provides canonical Project repositories and coordination services while Claudian coding agents and private work remain on participant devices.

User authentication is outside this repository. Deployments must provide their own trusted ingress and authentication system. Claudian Cloud Server accepts the resulting trusted caller identity and handles Project membership and authorization for admitted requests.

## Development

The scaffold is pinned to Node.js 24.16.0. The `.node-version` file declares the version but does not switch an unmanaged shell automatically. Use any Node.js version manager that supports this file. With `fnm` installed, select the project version with:

```bash
fnm install
fnm use
node --version
```

Once `node --version` reports `v24.16.0`, install and verify with:

```bash
npm ci
npm run verify
```

The current foundation provides loopback-only private-development startup, safe structured logging, liveness at `/livez`, readiness at `/readyz`, and bounded graceful shutdown. Project APIs, Git transport, persistence, and the protocol-backed version endpoint are not implemented yet.

## Deployment

For a local process smoke test, copy `.env.example` to `.env.private-development.local` and edit the local copy. Files matching `.env.*` are ignored by Git except for `.env.example`.

```bash
cp .env.example .env.private-development.local
npm run build
node --env-file=.env.private-development.local dist/main.js
```

The private-development server deliberately binds only to `127.0.0.1`. An operator may publish it through a private ingress without changing the application bind address.

Application runtime values belong in `.env.private-development.local`. Deployment access, credentials, and private-ingress configuration remain outside this repository.

The Linux deployment uses the pinned image and Compose model in `deploy/`. It uses host networking so the container can preserve a configured loopback bind; it does not publish a Docker port. Validate and build it with:

```bash
npm run check:deployment
docker build --file deploy/Dockerfile --tag claudian-cloud-server:local .
```

On the deployment host, keep the runtime environment outside the repository checkout at `/etc/claudian-cloud-server/server.env`, readable only by the deployment operator. Start the service with:

```bash
docker compose -f deploy/compose.yaml up --detach --build
```

The deployment deliberately does not select or configure a private-ingress product. The operator owns that boundary and may forward its private endpoint to the configured loopback port only after the loopback health checks pass. PostgreSQL and repository storage join the deployment only when their owning implementations and recovery contracts exist.

### Git-backed updates

The deployment host authenticates to the Git remote through operator-owned credentials outside this repository. From a clean clone, `deploy/deploy.sh` fetches the remote, resolves `origin/main` or `CLAUDIAN_DEPLOY_REF` to one commit, builds an image tagged with the full commit SHA, and waits for Compose health. If the replacement is unhealthy, it restores the image that was running before the update.

```bash
deploy/deploy.sh
```

The runtime environment defaults to `/etc/claudian-cloud-server/server.env`. Operators may set `CLAUDIAN_DEPLOY_ENV_FILE`, `CLAUDIAN_DEPLOY_IMAGE_REPOSITORY`, `CLAUDIAN_DEPLOY_WAIT_TIMEOUT_SECONDS`, or `CLAUDIAN_DEPLOY_BUILD_NETWORK` without placing those values in the repository. Compose defaults to limits of 1.5 CPUs, 1 GiB of memory, and 256 PIDs; set `CLAUDIAN_DEPLOY_CPUS`, `CLAUDIAN_DEPLOY_MEMORY`, or `CLAUDIAN_DEPLOY_PIDS` in the operator environment to match the selected host. The script refuses dirty checkouts, so only committed source can become a deployment image.
