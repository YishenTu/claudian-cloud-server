# Installation and configuration

**Provide your own authenticated ingress.** This package installs the server and database only. The operator must configure access authentication, TLS or an encrypted tunnel, and forwarding as described in [Connect Claudian](../README.md#connect-claudian).

## Install

Requires Linux amd64 or arm64, Docker Engine with Compose **2.24.0+**, Bash, `curl`, `tar`, `sha256sum`, and `sudo`. Docker must be running and accessible through `sudo docker`. Default loopback ports: server `8787`, PostgreSQL `5432`.

Download `claudian-cloud-server.tar.gz` and `claudian-cloud-server.tar.gz.sha256` from the same [release](https://github.com/YishenTu/claudian-cloud-server/releases/latest) into an empty directory on the deployment host. For a fresh installation, run each command only after the previous one succeeds:

```bash
sha256sum --check claudian-cloud-server.tar.gz.sha256
tar -xzf claudian-cloud-server.tar.gz
cd claudian-cloud-server
sudo bash deploy/configure.sh
```

This downloads the release image and generates configuration, database credentials, and a storage keyring under `/etc/claudian-cloud-server`. Existing configuration is never overwritten. If you need a different [server port](#server-port-and-settings), [PostgreSQL port](#postgresql-port), or [resource limits](#resource-limits), configure them now.

From the extracted `claudian-cloud-server` directory, initialize the database and start the server:

```bash
compose() { sudo docker compose --env-file release.env -f deploy/compose.yaml "$@"; }
compose up --detach --wait postgres
compose --profile bootstrap run --rm cloud-bootstrap
compose --profile migration run --rm --no-deps cloud-migration
compose up --detach --wait --no-build cloud-server
curl --fail http://127.0.0.1:8787/readyz
```

Use your configured server port in the readiness check. Once it succeeds, [connect Claudian](../README.md#connect-claudian).

Keep the extracted release directory for subsequent Compose commands and retain the generated configuration and keyring for recovery. PostgreSQL and repository data persist in Docker volumes. Keep configuration and credentials outside the checkout.

## Server port and settings

Edit the generated configuration:

```bash
sudoedit /etc/claudian-cloud-server/server.env
```

For example, set `CLAUDIAN_CLOUD_PORT=9000`, then forward your authenticated entry point to `127.0.0.1:9000`. Keep `CLAUDIAN_CLOUD_BIND_HOST=127.0.0.1` and `CLAUDIAN_CLOUD_PRINCIPAL_PROFILE=vault-credential`.

If the server is already running, recreate its container to load the edited environment file:

```bash
sudo docker compose --env-file release.env -f deploy/compose.yaml up --detach --wait --no-build --no-deps --force-recreate cloud-server
curl --fail http://127.0.0.1:9000/readyz
```

Use your configured port in the readiness check. Recreation applies configuration to the installed image; it does not upgrade the server.

## Resource limits

Tune both the application budgets in `server.env` and the container limits in `release.env`. A larger host does not raise either automatically.

| File | Settings |
| --- | --- |
| `server.env` | Database pools, Git concurrency and queues, event connections, upload limits, and staging reservations. See [.env.example](../.env.example) for all parameters and defaults. |
| `release.env` | `CLAUDIAN_DEPLOY_CPUS=1.5`, `CLAUDIAN_DEPLOY_MEMORY=1g`, `CLAUDIAN_DEPLOY_PIDS=256`. Keep its existing `CLAUDIAN_CLOUD_IMAGE` entry. |

Defaults target a small installation: 512 event connections globally and 64 per Project. Each open Project on each device consumes a connection. These are resource budgets, not a supported-user guarantee; repository sizes and operation rates determine actual capacity.

Monitor CPU, memory, queue waits, and operation latency before raising concurrency. Provision matching container, PostgreSQL, and disk capacity; larger queues only allow more waiting work. Per-Project and read/write isolation constraints still apply, and inconsistent settings are rejected. Upload and checkpoint attempts retain their disk reservations until their owning work releases them; protocol limits remain fixed.

Apply changes with the server recreation command above. Keep the generated storage identity and paths for the supplied Docker layout. Path changes require matching persistent mounts, with repository and staging directories kept as distinct siblings.

## PostgreSQL port

For a fresh installation with a port other than `5432`, make all of these changes before starting services:

- Set `CLAUDIAN_CLOUD_POSTGRES_PORT` in `release.env`.
- Update the port in the database URLs in `/etc/claudian-cloud-server/server.env` and `/etc/claudian-cloud-server/migration.env`.
- Set the same `PGPORT` in `/etc/claudian-cloud-server/bootstrap.env`.

Choose available loopback ports for both PostgreSQL and the server. Configure access authentication, TLS, and forwarding separately in your entry point.
