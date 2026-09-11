# Claudian Cloud Server

Self-hosted collaboration services for [Claudian](https://github.com/YishenTu/claudian) Collab Mode, independent of a participant's LAN Host. Runs from prebuilt Docker images; coding agents stay on participant devices. [Learn more](https://claudian.md/docs/collab-mode/).

## Install and setup

Use the prebuilt package from the [latest release](https://github.com/YishenTu/claudian-cloud-server/releases/latest). Requires Linux amd64 or arm64, Docker Engine with Compose **2.24.0+**, and `sudo` access.

**Operators must provide authenticated ingress and port forwarding.** Cloud Server listens only on `127.0.0.1` (default port `8787`). Secure your entry point with TLS or an encrypted tunnel.

1. Download `claudian-cloud-server.tar.gz` and its `.sha256` file from the same release's **Assets**.
2. Follow the [install and setup guide](deploy/README.md) to verify the package, extract it, and start the services.

## Connect Claudian

Enter your ingress URL as the Cloud Server address in Claudian. For example, if ingress forwards `10.0.0.10:9000` to the server host's `127.0.0.1:8787`, enter `http://10.0.0.10:9000` when using an encrypted tunnel, or the corresponding `https://` URL for TLS ingress.

## Configuration

Defaults target a small self-hosted installation: **1.5 CPUs and 1 GiB memory** for the application container, with PostgreSQL running in a separate container included in the deployment. Event connection limits are **512 across the server and 64 per Project**. Each open Project on a device uses one connection; practical capacity depends on repository size and activity.

See the deployment guide for [configuration](deploy/README.md#server-port-and-settings), [resource limits](deploy/README.md#resource-limits), and [software updates](deploy/README.md#software-updates).

## License

[MIT License](LICENSE).
