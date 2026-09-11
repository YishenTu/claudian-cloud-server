# Install and setup

This guide covers installation, configuration, and [software updates](#software-updates) using prebuilt releases. The package includes the application, a separate PostgreSQL container, and deployment commands. Installation and release updates do not require a source checkout, Node.js, or a local image build.

**You must provide authenticated ingress and port forwarding.** The application and PostgreSQL listen only on the deployment host's loopback interface. The package does not install an external entry point. Complete [ingress setup](#4-configure-ingress-and-connect-claudian) before connecting remote clients.

## Prerequisites

- Linux on amd64 or arm64, Docker Engine with Compose **2.24.0+**, and `sudo` access.
- Bash, `curl`, `tar`, and `sha256sum`. Docker must be running and accessible through `sudo docker`.
- Network access to download GitHub release assets and pull images from GitHub Container Registry and Docker Hub.
- Available loopback ports: `8787` for the application and `5432` for PostgreSQL by default. Both can be changed before startup.
- Persistent disk space for PostgreSQL, repositories, temporary uploads, and any retained backups or exports. Allow host memory and CPU for PostgreSQL and the operating system in addition to the application's default limits; see [resource limits](#resource-limits).

The supplied Compose configuration uses Linux host networking, so `127.0.0.1` inside these containers is the host's loopback interface. Keep this layout; adding published ports or changing the application bind address is not needed for ingress.

## 1. Download and verify

Download `claudian-cloud-server.tar.gz` and `claudian-cloud-server.tar.gz.sha256` from the same [release's Assets](https://github.com/YishenTu/claudian-cloud-server/releases/latest). Place both files in an empty directory on the deployment host.

Run the following commands in order, continuing only when the preceding command succeeds:

```bash
sha256sum --check claudian-cloud-server.tar.gz.sha256
tar -xzf claudian-cloud-server.tar.gz
cd claudian-cloud-server
```

The checksum command must report `claudian-cloud-server.tar.gz: OK`. If it fails, download both assets again from the same release before extracting. The extracted `release.env` selects the release's immutable application image digest; keep that entry unchanged.

Run all remaining Compose commands from the extracted `claudian-cloud-server` directory. Keep this directory for later configuration and maintenance, including `release.env`, `revision.txt`, and `deploy/`.

## 2. Generate configuration

```bash
sudo bash deploy/configure.sh
```

The script pulls the application image, generates database credentials and a claim-custody keyring, and prepares backup and export directories. It does not start the services. It refuses to run if `/etc/claudian-cloud-server` already exists, so it cannot overwrite an existing installation.

Generated files live under `/etc/claudian-cloud-server`:

| File | Purpose |
| --- | --- |
| `server.env` | Application settings and the runtime database credential. |
| `postgres.env` | PostgreSQL container initialization settings and its bootstrap credential. |
| `bootstrap.env` | Credentials for provisioning the application database, roles, and repository volume. |
| `migration.env` | Separate database credential for schema initialization and restore operations. |
| `claim-custody-keyring.json` | Keys used to protect claim custody and verify its receipts; preserve this file with the installation. |

These files contain secrets. Keep them outside the release directory and source control, preserve their generated ownership and restrictive permissions, and retain a protected recovery copy. The runtime uses numeric user `10001`; the initializer sets the keyring and artifact directory ownership for that user.

If the defaults do not fit your host, change the [server port](#server-port-and-settings), [PostgreSQL port](#postgresql-port), or [resource limits](#resource-limits) now, before starting services.

## 3. Initialize and start

Define this helper in your current Bash shell. Define it again when opening a new shell for later commands:

```bash
compose() { sudo bash deploy/deploy.sh --compose "$@"; }
```

The helper selects the active release, including after an update, and preserves the installation's Compose settings.

Start PostgreSQL and wait for it to become healthy:

```bash
compose up --detach --wait postgres
```

Provision the application database and roles, and pair the database with the persistent repository volume:

```bash
compose --profile bootstrap run --rm cloud-bootstrap
```

Create the canonical database schema:

```bash
compose --profile migration run --rm --no-deps cloud-migration
```

Despite its service name, `cloud-migration` initializes an absent schema; it does not upgrade an older schema. Existing installations must already have the exact schema required by the image.

Start the application:

```bash
compose up --detach --wait --no-build cloud-server
curl --fail http://127.0.0.1:8787/readyz
```

Startup runs restore recovery and then Project recovery before starting the server. Both gates must succeed; do not disable them to bypass an error. The readiness request must return HTTP `200` with `{"status":"ready"}`. Use your configured application port if you changed it. Docker's health check uses `/livez`, so the explicit `/readyz` check confirms readiness beyond container liveness.

If a command fails, stop at that step and inspect [status and logs](#status-and-troubleshooting) before proceeding.

## 4. Configure ingress and connect Claudian

Configure an entry point that authenticates access and forwards traffic to the server host's `127.0.0.1:8787`, or your configured application port. Protect traffic with TLS or an encrypted tunnel. Ingress can use a different external address and port from the application's loopback listener.

Your ingress must:

- Enforce operator-controlled access authentication. The server's Vault credential verification and Project membership checks are separate and do not replace this access control.
- Preserve the client's `Authorization` header unchanged. Do not replace it with an ingress credential; choose an access mechanism compatible with Claudian's requests.
- Forward request paths, queries, and bodies unchanged, including Git Smart HTTP traffic, WebSocket upgrades, and streamed uploads and responses. Configure connection timeouts to accommodate long-lived event connections and repository transfers.

For example, if an authenticated encrypted tunnel makes `10.0.0.10:9000` reachable from the client and forwards it to the server host's `127.0.0.1:8787`, enter `http://10.0.0.10:9000` as the Cloud Server address in Claudian. For TLS ingress, enter its `https://` URL, such as `https://cloud.example.com`. Plain HTTP in this example depends on the encrypted tunnel covering the connection.

The address entered in Claudian must be reachable from the participant's device. `127.0.0.1` on that device refers to the device itself; use it only when a local tunnel endpoint forwards from that device to the server. If ingress runs in a separate container or on another host, arrange its path to the deployment host's loopback listener accordingly.

After the local readiness check succeeds, verify that an authorized client can connect through ingress, open a Project, receive events, and transfer repository data. A successful health request alone does not verify authentication, WebSocket forwarding, or Git transfers.

## Server port and settings

Edit the generated application environment file:

```bash
sudoedit /etc/claudian-cloud-server/server.env
```

For example, set `CLAUDIAN_CLOUD_PORT=9000`, then forward ingress to the server host's `127.0.0.1:9000`. Keep `CLAUDIAN_CLOUD_BIND_HOST=127.0.0.1` and `CLAUDIAN_CLOUD_PRINCIPAL_PROFILE=vault-credential`.

See [.env.example](../.env.example) for settings and defaults. Edit the generated `server.env`; changing the packaged example does not change an existing installation. Keep the generated storage identity and paths for the supplied Docker layout. Custom paths require matching persistent mounts, with repository and staging directories kept as distinct siblings.

For an already initialized, running installation, apply application settings or container limit changes by recreating the application container:

```bash
compose up --detach --wait --no-build --no-deps --force-recreate cloud-server
curl --fail http://127.0.0.1:9000/readyz
```

This briefly interrupts client connections. Use your actual port in the readiness check and update the ingress forwarding target if it changed. A container restart alone does not load changed environment files. This command applies configuration to the same installed image; it is not an upgrade or recovery procedure.

## Resource limits

The default application container is limited to **1.5 CPUs, 1 GiB memory, and 256 processes**. PostgreSQL runs in a separate container included in the deployment; these application limits do not cover PostgreSQL or the whole host.

Tune both application budgets and container limits. A larger host does not raise either automatically. After a software update, use `sudo bash deploy/deploy.sh --directory` to find the active release directory before editing its `release.env`:

| File | What to change |
| --- | --- |
| `/etc/claudian-cloud-server/server.env` | Database pools, Git concurrency and queues, event connections, upload limits, and staging reservations. Parameter names and defaults are in [.env.example](../.env.example). |
| `release.env` in the active release directory | Add or edit `CLAUDIAN_DEPLOY_CPUS=1.5`, `CLAUDIAN_DEPLOY_MEMORY=1g`, and `CLAUDIAN_DEPLOY_PIDS=256` with the desired values. Preserve the existing `CLAUDIAN_CLOUD_IMAGE` entry. |

Default event limits allow **512 connections across the server and 64 per Project**. Each open Project on each device consumes one connection. These limits describe connection budgets, not a guaranteed number of supported users; repository sizes, transfer activity, and simultaneous operations affect practical capacity.

Start with the defaults and observe CPU, memory, disk space, queue waits, and operation latency under your workload. Increase concurrency only with matching application, PostgreSQL, and disk capacity. Larger queues allow more work to wait but do not increase processing capacity. Inconsistent budgets are rejected, and protocol limits remain fixed.

Apply application budget and container limit changes with the recreation command in [server port and settings](#server-port-and-settings).

## PostgreSQL port

For a fresh installation that cannot use `5432`, make all of these changes before starting services:

1. Add `CLAUDIAN_CLOUD_POSTGRES_PORT=5433` to `release.env`, using an available port of your choice.
2. Change the port in the database URLs in `/etc/claudian-cloud-server/server.env` and `/etc/claudian-cloud-server/migration.env` to the same value. Keep their generated usernames and passwords.
3. Set `PGPORT` in `/etc/claudian-cloud-server/bootstrap.env` to the same value.

PostgreSQL stays on `127.0.0.1`. Its port is for server-side database connections; clients connect only to your application ingress URL. Moving the database port of a running installation requires a coordinated database and application restart; recreating only `cloud-server` is insufficient.

## Persistence and maintenance

PostgreSQL data persists in the Compose `postgres-data` volume. Repositories and authority state persist in `cloud-authority`. These volumes form one installation and must be retained together with its generated configuration and keyring. Keep the supplied Compose project name when operating this installation so commands continue to select the same volumes.

Backup artifacts and catalogs live under `/var/lib/claudian-cloud-server/backups`; export artifacts live under `/var/lib/claudian-cloud-server/exports`. The initializer creates these directories, but installation does not create or schedule backups. Persistent volumes protect data across container replacement; they are not a backup. Database and Git state require a coordinated backup and verified restore, rather than independent live copies of the two volumes.

Do not use `docker compose down --volumes`, delete one volume, or regenerate credentials or keys to fix startup errors. A database/volume mismatch is intentionally rejected. Retain the original data and investigate the exact failed operation.

If you use Project exports, schedule the supplied `cloud-reconcile-exports` service through your operator scheduler to clean expired export artifacts:

```bash
compose --profile reconcile-exports run --rm --no-deps cloud-reconcile-exports
```

Choose a schedule appropriate to your export retention and disk budget. This command is a single cleanup run; it does not install a schedule.

## Software updates

From the original installation directory, update to the latest stable release:

```bash
sudo bash deploy/deploy.sh --update
```

To select a specific published release, including a prerelease, pass its tag:

```bash
read -r -p 'Target release tag: ' release_tag
sudo bash deploy/deploy.sh --update "$release_tag"
```

The command downloads the release archive and checksum over HTTPS, verifies the archive, and pulls the immutable image. It preserves the installation's `release.env` settings, external configuration, keyring, PostgreSQL, and persistent volumes. It does not build locally, rerun bootstrap, or apply schema migrations. PostgreSQL stays running throughout the update.

### Before updating

1. Read the target release's compatibility notes. Existing data must match its exact schema. There is no automatic in-place schema upgrade; an incompatible schema requires a separately documented and verified clean restore. Do not proceed if compatibility is unknown.
2. Retain a coordinated backup with verified restore evidence, the configuration and keyring, and the original installation directory. Make sure the host has room to pull the new image while retaining the previous image.
3. Schedule a client interruption and pause other operator deployment or maintenance jobs. Downloads and image pulls happen while the old application is running; authority verification and recovery require stopping it.
4. Keep deployment settings in the active release's `release.env` and use absolute paths for any custom configuration files or artifact directories. Custom edits to `compose.yaml` are not carried forward automatically; reconcile them with the target release before using this command.
5. Ensure the host has `curl`, `tar`, `sha256sum`, and `flock`, in addition to Docker and Bash. The updater needs access to public GitHub release assets and the image registry. It does not install credentials for private release downloads.

Do not update the PostgreSQL version, move storage, or change the database port as part of the same operation. If you use custom deployment lock or state paths, keep passing the same settings on every invocation.

### What the updater does

The updater prepares the new release in a protected directory under `/var/lib/claudian-cloud-server/deploy-forward.releases`. It keeps a private snapshot of the resolved Compose configuration for the duration of an update; this snapshot contains environment values and must not be shared.

After stopping the old application, it verifies that the candidate can open the current authority. Before the first recovery mutation, it writes `/var/lib/claudian-cloud-server/deploy-forward`, binding the revision, image identity, operation, and cached configuration. It runs restore recovery, Project recovery, and application startup in that order. It requires `/readyz` to return HTTP `200` before marking the new release active and clearing the recovery record. Concurrent deployment commands using the same lock are rejected.

A successful update prints `deployment.ready`. Verify that Claudian can reconnect through ingress, receive events, and transfer repository data before resuming normal operator jobs.

### Commands and configuration after updating

Keep using `deploy/deploy.sh` from the original installation directory. It selects the active release for later updates and `--compose` commands. The `compose` helper defined above therefore continues to select the updated application.

Find the active release directory with:

```bash
sudo bash deploy/deploy.sh --directory
```

Edit `release.env` in that directory when changing deployment limits or Compose settings. Application settings remain in `/etc/claudian-cloud-server/server.env`. Apply changes using the existing [container recreation command](#server-port-and-settings).

The original release files remain intact. Do not run raw Compose commands against their old `release.env` after updating; doing so can select the old image. Keep the updater's state directory and active cached release. The updater removes temporary resolved configuration snapshots after success, but does not prune Docker images or delete retained release bundles.

### Failed or interrupted updates

| Failure stage | What to do |
| --- | --- |
| Download, checksum, archive validation, image pull, or configuration validation | Resolve the reported error and rerun. These steps happen before the application is stopped. |
| Process interruption after stopping the application but before a recovery record exists | Rerun the update command. It can verify and update the existing stopped installation. |
| Candidate authority verification | The updater attempts to reopen the previous image with its previous configuration because recovery has not begun. Check readiness and resolve the reported incompatibility before retrying. |
| Restore recovery, Project recovery, application startup, or readiness | Preserve the recovery record, cached release, image, configuration, and volumes. Resolve the error and rerun the same update command. It resumes the recorded candidate without downloading or selecting a newer release. |
| Recovery record or active release record cannot be written or settled | Preserve the files and images and investigate the reported failure. Do not remove a record to force progress. |
| Cached candidate has changed or is unavailable | Restore the exact retained candidate evidence before retrying. The updater rejects a different image, revision, or configuration after recovery has begun. |

A pending update takes precedence over a newly supplied tag. Once the recovery record exists, recovery may already have changed persistent state: do not delete the record, prune the candidate image, or manually restart an older image. Continue forward with the recorded candidate. A rollback after that point requires a separately verified restore procedure.

The `--compose` helper rejects commands while an update is pending. Use `sudo docker ps --all` and `sudo docker logs CONTAINER` to inspect the affected containers, then retry the update. Do not start another maintenance operation against the same installation.

### Existing installations without the updater

For a release that predates this command, download and verify a new installation archive in a separate directory. Copy only its `deploy/deploy.sh` and `deploy/release-update.sh` into the existing installation's `deploy/` directory, then run `--update` there. Retain the old installation's `release.env`, Compose file, configuration, and data; do not rerun `configure.sh` or the fresh-install initialization steps.

Operators deploying from a source checkout can continue to use `bash deploy/deploy.sh` without `--update`. That path builds the selected `CLAUDIAN_DEPLOY_REF` and uses the same authority verification and recovery fence. Complete an interrupted update using the same deployment mode that started it.

## Status and troubleshooting

From the extracted release directory, using the `compose` helper defined above:

```bash
compose ps --all
compose logs --tail 100 postgres cloud-restore-recovery cloud-project-recovery cloud-server
curl --fail http://127.0.0.1:8787/readyz
```

Use your configured application port. Bootstrap and schema initialization run with `--rm`; inspect their terminal output when they fail, since their containers are removed afterward.

| Symptom | What to check |
| --- | --- |
| Image pull fails | Host network access and registry availability; confirm the release's image digest was preserved. |
| `configuration-already-exists` | Configuration from an earlier attempt or installation is present. Inspect it and the installation state; do not delete it and rerun blindly. |
| PostgreSQL cannot start or connect | Port conflicts, PostgreSQL status, and matching ports and generated credentials across the configuration files. |
| Bootstrap reports a database/volume mismatch | Confirm you selected the original Compose project and paired volumes. Do not initialize a replacement volume against an existing database. |
| Schema initialization or recovery fails | Read the failed command or recovery service output and verify release compatibility. Preserve state and resolve the reported failure before startup. |
| Container is healthy but `/readyz` fails | Health checks report liveness. Inspect application and recovery status; a `503` means the process is not ready. |
| Local readiness succeeds but Claudian cannot connect | Check the client-facing URL, ingress authentication, forwarding target, and preservation of `Authorization`, WebSockets, and streamed traffic. |
| Settings appear unchanged | Confirm you edited the generated configuration and recreated the affected container. |

Keep credentials, keyring contents, repository content, and rendered environment values out of shared diagnostics. Use service status and the server's sanitized error output to investigate failures.
