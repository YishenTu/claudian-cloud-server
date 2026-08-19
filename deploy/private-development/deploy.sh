#!/usr/bin/env bash

set -Eeuo pipefail

fail() {
  printf 'deployment.error: %s\n' "$1" >&2
  exit 1
}

repository_root="$(git rev-parse --show-toplevel 2>/dev/null)" || \
  fail 'not-a-git-checkout'
cd "$repository_root"

if [[ -n "$(git status --porcelain --untracked-files=all)" ]]; then
  fail 'dirty-checkout'
fi

deployment_ref="${CLAUDIAN_DEPLOY_REF:-origin/main}"
environment_file="${CLAUDIAN_DEPLOY_ENV_FILE:-/etc/claudian-cloud-server/server.env}"
image_repository="${CLAUDIAN_DEPLOY_IMAGE_REPOSITORY:-claudian-cloud-server}"
wait_timeout="${CLAUDIAN_DEPLOY_WAIT_TIMEOUT_SECONDS:-30}"
build_network="${CLAUDIAN_DEPLOY_BUILD_NETWORK:-}"
compose_file='deploy/private-development/compose.yaml'
dockerfile='deploy/private-development/Dockerfile'

[[ -r "$environment_file" ]] || fail 'environment-file-unreadable'
[[ "$wait_timeout" =~ ^[1-9][0-9]*$ ]] || fail 'invalid-wait-timeout'

git fetch --prune origin
revision="$(git rev-parse --verify "${deployment_ref}^{commit}")" || \
  fail 'deployment-ref-not-found'
git checkout --detach "$revision"

image="${image_repository}:${revision}"
compose=(docker compose --file "$compose_file")
build=(docker build)
if [[ -n "$build_network" ]]; then
  build+=(--network "$build_network")
fi
build+=(--file "$dockerfile" --tag "$image" .)

CLAUDIAN_CLOUD_ENV_FILE="$environment_file" \
CLAUDIAN_CLOUD_IMAGE="$image" \
  "${compose[@]}" config --quiet

container_id="$({
  CLAUDIAN_CLOUD_ENV_FILE="$environment_file" \
  CLAUDIAN_CLOUD_IMAGE="$image" \
    "${compose[@]}" ps --quiet cloud-server
} 2>/dev/null || true)"
previous_image=''
if [[ -n "$container_id" ]]; then
  previous_image="$(docker inspect --format '{{.Config.Image}}' "$container_id")"
fi

printf 'deployment.building revision=%s image=%s\n' "$revision" "$image"
"${build[@]}"

set +e
CLAUDIAN_CLOUD_ENV_FILE="$environment_file" \
CLAUDIAN_CLOUD_IMAGE="$image" \
  "${compose[@]}" up \
    --detach \
    --no-build \
    --wait \
    --wait-timeout "$wait_timeout"
deployment_status=$?
set -e

if [[ $deployment_status -eq 0 ]]; then
  printf 'deployment.ready revision=%s image=%s\n' "$revision" "$image"
  exit 0
fi

printf 'deployment.unhealthy revision=%s image=%s\n' "$revision" "$image" >&2
if [[ -z "$previous_image" ]]; then
  fail 'replacement-failed-without-rollback-image'
fi

printf 'deployment.rolling-back image=%s\n' "$previous_image" >&2
if ! CLAUDIAN_CLOUD_ENV_FILE="$environment_file" \
  CLAUDIAN_CLOUD_IMAGE="$previous_image" \
  "${compose[@]}" up \
    --detach \
    --no-build \
    --wait \
    --wait-timeout "$wait_timeout"; then
  fail 'replacement-and-rollback-failed'
fi

printf 'deployment.rolled-back image=%s\n' "$previous_image" >&2
exit "$deployment_status"
