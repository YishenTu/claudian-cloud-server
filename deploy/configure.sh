#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

fail() {
  printf 'configuration.error: %s\n' "$1" >&2
  exit 1
}

[[ "$(uname -s)" == 'Linux' && "$EUID" == 0 ]] || fail 'run-as-root-on-linux'
release_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
image="$(sed -n 's/^CLAUDIAN_CLOUD_IMAGE=//p' "$release_root/release.env")"
[[ "$image" =~ ^ghcr\.io/[a-z0-9._/-]+@sha256:[a-f0-9]{64}$ ]] || fail 'release-image-invalid'
configuration='/etc/claudian-cloud-server'
[[ ! -e "$configuration" && ! -L "$configuration" ]] || fail 'configuration-already-exists'
docker pull "$image"
install -d -m 0700 "$configuration"

docker run --rm --interactive --network none --read-only \
  --user 0:0 --cap-drop ALL --cap-add CHOWN \
  --security-opt no-new-privileges:true \
  --mount "type=bind,source=$configuration,target=/config" \
  --mount "type=bind,source=$release_root/.env.example,target=/template,readonly" \
  --entrypoint node "$image" --input-type=module-typescript \
  < "$release_root/deploy/initializeConfig.ts"

install -d -m 0700 -o 10001 -g 10001 \
  /var/lib/claudian-cloud-server/backups/artifacts \
  /var/lib/claudian-cloud-server/backups/catalogs \
  /var/lib/claudian-cloud-server/exports/artifacts
