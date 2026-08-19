# Claudian Cloud Server

Claudian Cloud Server is the public, auditable collaboration data plane for Claudian Collab. It provides canonical Project repositories and coordination services while Claudian coding agents and private work remain on participant devices.

User authentication is outside this repository. Deployments must provide their own trusted ingress and authentication system. Claudian Cloud Server accepts the resulting trusted caller identity and handles Project membership and authorization for admitted requests.

## Deployment

The current Linux deployment builds from source. After configuring Git access on the deployment host, clone the repository, create the runtime environment file, and start the service with Docker Compose:

```bash
git clone https://github.com/YishenTu/claudian-cloud-server.git
cd claudian-cloud-server
sudo install -d -m 0750 -o "$(id -u)" -g "$(id -g)" /etc/claudian-cloud-server
sudo install -m 0600 -o "$(id -u)" -g "$(id -g)" .env.example /etc/claudian-cloud-server/server.env
sudoedit /etc/claudian-cloud-server/server.env
docker compose -f deploy/compose.yaml up --detach --build --wait
```

The application remains reachable only on the configured loopback port.

For later updates, run the deployment script from the clean checkout. By default, it deploys the latest `origin/main`, verifies service health, and rolls back an unhealthy replacement.

```bash
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
