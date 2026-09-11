# Claudian Cloud Server

Self-hosted collaboration services for [Claudian](https://github.com/YishenTu/claudian) Collab Mode, independent of a participant's LAN Host. Runs from prebuilt Docker images; coding agents stay on participant devices. [Learn more](https://claudian.md/docs/collab-mode/).

## Install

Use the prebuilt package from the [latest release](https://github.com/YishenTu/claudian-cloud-server/releases/latest). Requires Linux amd64 or arm64, Docker Engine with Compose **2.24.0+**, and `sudo` access.

1. Download `claudian-cloud-server.tar.gz` and its `.sha256` file from the same release.
2. Follow the [installation guide](deploy/README.md#install) to verify the package, extract it, and start the services.
3. [Connect Claudian](#connect-claudian) through your authenticated entry point.

Choose the installation package under **Assets**; no source checkout or local image build is needed.

## Connect Claudian

In Claudian, enter your authenticated ingress URL as the Cloud Server address. For example, enter `http://10.0.0.10:9000` when that endpoint is reached through an encrypted tunnel; use an `https://` URL for TLS ingress.

**Cloud Server listens only on `127.0.0.1` (default port `8787`).** The operator must provide ingress access authentication and port forwarding—for the example above, from `10.0.0.10:9000` to the server host's `127.0.0.1:8787`. The server's Vault credential and Project permission checks do not replace ingress authentication.

Your entry point must preserve the client's `Authorization` header, WebSocket upgrades, and streamed bodies when forwarding to the server.

## Configuration

Defaults target a small self-hosted installation: **1.5 CPUs and 1 GiB memory** for the application container, with PostgreSQL provisioned separately. Event connection limits are **512 across the server and 64 per Project**. Each open Project on a device uses one connection; practical capacity depends on repository size and activity.

For different ports or larger workloads, see [deployment configuration](deploy/README.md) for server settings, container limits, and how to apply changes.

## License

[MIT License](LICENSE).
