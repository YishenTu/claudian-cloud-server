# Claudian Cloud Server

Persistent Git repositories and collaboration services for Claudian Collab, distributed as Docker images for Linux amd64 and arm64.

**Access authentication and port forwarding are not included.** The server listens only on `127.0.0.1`, with a configurable port (default `8787`). Configure your own authenticated entry point using TLS or an encrypted tunnel. It must forward traffic to the configured port and preserve the client's `Authorization` header, WebSocket upgrades, and streamed bodies. The server verifies Claudian Vault credentials and Project permissions.

## Install

Requires a Linux amd64 or arm64 host, Docker Engine, the Docker Compose plugin **2.24.0 or newer**, Bash, `curl`, `tar`, `sha256sum`, and a user with `sudo` access. Docker must be running and accessible through `sudo docker`. The loopback ports must be available (defaults: PostgreSQL `5432`, server `8787`).

For a fresh installation, start in an empty directory. For a public release, download the installation files:

```bash
curl -fL https://github.com/YishenTu/claudian-cloud-server/releases/latest/download/claudian-cloud-server.tar.gz -o claudian-cloud-server.tar.gz
curl -fL https://github.com/YishenTu/claudian-cloud-server/releases/latest/download/claudian-cloud-server.tar.gz.sha256 -o claudian-cloud-server.tar.gz.sha256
```

For a private release, use [GitHub CLI](https://cli.github.com/) with an account that has read access to the repository. Authenticate once, then download the installation files instead:

```bash
gh auth login --hostname github.com
gh release download --repo YishenTu/claudian-cloud-server --pattern 'claudian-cloud-server.tar.gz*'
```

Private images also require read access to the GHCR package. Before configuring or starting services, run `sudo docker login ghcr.io --username YOUR_GITHUB_USERNAME` and enter a personal access token (classic) with `read:packages` at the password prompt. Using `sudo` stores the login for the same Docker client that runs the installation commands. See [GitHub's Container registry authentication requirements](https://docs.github.com/en/packages/working-with-a-github-packages-registry/working-with-the-container-registry#authenticating-to-the-container-registry).

After downloading either release, run these commands in order. Continue only when each command succeeds:

```bash
sha256sum --check claudian-cloud-server.tar.gz.sha256
tar -xzf claudian-cloud-server.tar.gz
cd claudian-cloud-server
sudo bash deploy/configure.sh
```

The initializer downloads the release image and generates separate database credentials and a storage keyring under `/etc/claudian-cloud-server`. It refuses to overwrite existing configuration. No Node.js installation, source checkout, or local image build is required.

To change ports or limits, edit the [configuration](#configuration) before starting services below; replace `8787` in the readiness check if you change the server port. Run from the extracted `claudian-cloud-server` directory:

```bash
compose() { sudo docker compose --env-file release.env -f deploy/compose.yaml "$@"; }
compose up --detach --wait postgres
compose --profile bootstrap run --rm cloud-bootstrap
compose --profile migration run --rm --no-deps cloud-migration
compose up --detach --wait --no-build cloud-server
curl --fail http://127.0.0.1:8787/readyz
```

Once the readiness check succeeds, connect Claudian to your authenticated entry-point URL. Keep the extracted release directory for Compose commands and retain the generated configuration and keyring for recovery. PostgreSQL and repository data persist in Docker volumes.

## Configuration

Edit the generated server configuration:

```bash
sudoedit /etc/claudian-cloud-server/server.env
```

For example, change the existing port setting to:

```dotenv
CLAUDIAN_CLOUD_PORT=9000
```

Forward your authenticated entry point to `127.0.0.1:9000` and use `http://127.0.0.1:9000/readyz` for the readiness check. If the server is already running, apply the change from the extracted release directory:

```bash
sudo docker compose --env-file release.env -f deploy/compose.yaml up --detach --wait --no-build --no-deps --force-recreate cloud-server
curl --fail http://127.0.0.1:9000/readyz
```

Other server settings are listed in [.env.example](.env.example), which supplies the generated defaults. All names below have the `CLAUDIAN_CLOUD_` prefix.

| Settings | Purpose and defaults |
| --- | --- |
| `POSTGRES_URL`, `POSTGRES_*_POOL_MAX`, `PROJECT_LOCK_TIMEOUT_MS` | Runtime database connection; ordinary/pinned/reserved pools of 8/2/2 connections; Project lock timeout of 2 seconds. |
| `GIT_MAX_*`, `GIT_QUEUE_*` | Git concurrency and queues: 2 active processes globally, 1 per Project; 6 queued globally, 4 per Project; queue timeout of 10 seconds. Separate read/write limits also apply. |
| `GIT_OPERATION_TIMEOUT_MS`, `GIT_OUTPUT_MAX_BYTES` | Git operation timeout of 5 minutes and captured output limit of 1 MiB. |
| `EVENT_MAX_*` | 64 event connections globally, 16 per Project, and 16 pending authorizations. |
| `BOOTSTRAP_*` | Initial repository upload limits: 1 GiB each for the bundle and repository, 2 GiB staging reservation, 1 GiB free-space floor, queue size 4, queue timeout 10 seconds, upload deadline 15 minutes, and idle timeout 30 seconds. Size and upload timeout limits cannot exceed protocol maxima; the attempt lifetime is fixed at 24 hours. |
| `STORAGE_NODE_ID`, `REPOSITORY_ROOT`, `STAGING_ROOT`, `GIT_EXECUTABLE` | Storage identity, repository/staging paths, and Git executable. Keep the generated values for the supplied Docker layout; path changes require matching persistent mounts, and repository/staging directories must be distinct siblings. |

Keep `CLAUDIAN_CLOUD_BIND_HOST=127.0.0.1` and `CLAUDIAN_CLOUD_PRINCIPAL_PROFILE=vault-credential` for deployment. Configuration changes require container recreation; a restart alone does not load an edited environment file. The recreation command applies configuration to the same installed image.

Container settings belong in `release.env` alongside its existing image entry:

| Setting | Default |
| --- | --- |
| `CLAUDIAN_DEPLOY_CPUS` | `1.5` CPUs |
| `CLAUDIAN_DEPLOY_MEMORY` | `1g` memory |
| `CLAUDIAN_DEPLOY_PIDS` | `256` processes |
| `CLAUDIAN_CLOUD_POSTGRES_PORT` | `5432` |

Apply server container limits with the same recreation command above. To choose another PostgreSQL port for a fresh installation, set `CLAUDIAN_CLOUD_POSTGRES_PORT` in `release.env` and update the port in both generated URLs (`server.env` and `migration.env`) and `PGPORT` in `bootstrap.env` before starting services. Access authentication, TLS, and forwarding are configured separately in your chosen entry point.

[MIT License](LICENSE).
