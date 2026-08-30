# Claudian Cloud Server

Claudian Cloud Server is the public, auditable collaboration data plane for Claudian Collab. It provides canonical Project repositories and coordination services while Claudian coding agents and private work remain on participant devices.

User authentication is outside this repository. Deployments must provide their own trusted ingress and authentication system. Claudian Cloud Server accepts the resulting trusted caller identity and handles Project membership and authorization for admitted requests.

## Deployment

The current Linux deployment builds from source and keeps PostgreSQL and Cloud authority data in named volumes. After configuring Git access on the deployment host, clone the repository and create four separate operator-owned environment files:

```bash
git clone https://github.com/YishenTu/claudian-cloud-server.git
cd claudian-cloud-server
sudo install -d -m 0750 -o "$(id -u)" -g "$(id -g)" /etc/claudian-cloud-server
sudo install -m 0600 -o "$(id -u)" -g "$(id -g)" .env.postgres.example /etc/claudian-cloud-server/postgres.env
sudo install -m 0600 -o "$(id -u)" -g "$(id -g)" .env.bootstrap.example /etc/claudian-cloud-server/bootstrap.env
sudo install -m 0600 -o "$(id -u)" -g "$(id -g)" .env.migration.example /etc/claudian-cloud-server/migration.env
sudo install -m 0600 -o "$(id -u)" -g "$(id -g)" .env.example /etc/claudian-cloud-server/server.env
sudoedit /etc/claudian-cloud-server/postgres.env
sudoedit /etc/claudian-cloud-server/bootstrap.env
sudoedit /etc/claudian-cloud-server/migration.env
sudoedit /etc/claudian-cloud-server/server.env
```

Set the matching PostgreSQL port in the bootstrap environment and the two PostgreSQL URLs if port `5432` is unavailable. Then run the fresh-volume sequence explicitly:

```bash
export CLAUDIAN_CLOUD_POSTGRES_ENV_FILE=/etc/claudian-cloud-server/postgres.env
export CLAUDIAN_CLOUD_BOOTSTRAP_ENV_FILE=/etc/claudian-cloud-server/bootstrap.env
export CLAUDIAN_CLOUD_MIGRATION_ENV_FILE=/etc/claudian-cloud-server/migration.env
export CLAUDIAN_CLOUD_ENV_FILE=/etc/claudian-cloud-server/server.env
export CLAUDIAN_CLOUD_POSTGRES_PORT=5432
docker compose -f deploy/compose.yaml up --detach --wait postgres
docker compose -f deploy/compose.yaml --profile bootstrap run --rm cloud-bootstrap
docker compose -f deploy/compose.yaml build cloud-server
docker compose -f deploy/compose.yaml --profile migration run --rm --no-deps cloud-migration
docker compose -f deploy/compose.yaml up --detach --no-deps --wait cloud-server
```

The runtime never receives bootstrap or migration credentials and never applies schema. PostgreSQL and the Cloud application remain reachable only on their configured loopback ports.

For later current-schema code updates, run the deployment script from the clean checkout. By default, it deploys the latest `origin/main`, stops the running server, verifies the candidate against the unchanged authority, durably fences recovery to that exact revision and image, completes restore and Project recovery, and then opens the candidate. A verification failure before the fence reopens the unchanged previous image. After the fence, a failed or interrupted run resumes only the recorded candidate; the script never attempts a schema upgrade or rollback.

```bash
export CLAUDIAN_DEPLOY_ENV_FILE=/etc/claudian-cloud-server/server.env
export CLAUDIAN_DEPLOY_POSTGRES_ENV_FILE=/etc/claudian-cloud-server/postgres.env
deploy/deploy.sh
```

## Development

Development requires Node.js 24, npm, Docker, and Docker Compose. The exact Node.js version is recorded in `.node-version`.

```bash
# Install the exact dependencies recorded in package-lock.json.
npm ci
# Run lint, type checks, tests, and the production build.
npm run verify
```

## License

Licensed under the [MIT License](LICENSE).
