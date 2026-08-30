#!/usr/bin/env bash

set -Eeuo pipefail

fail() {
  printf 'deployment.error: %s\n' "$1" >&2
  exit 1
}

is_image_identity() {
  [[ "$1" =~ ^sha256:[0-9a-f]{64}$ ]]
}

is_operation_identity() {
  [[ "$1" =~ ^[0-9a-f]{64}$ ]]
}

is_git_revision() {
  [[ "$1" =~ ^[0-9a-f]{40}$ ]]
}

is_path_within() {
  [[ "$1" == "$2" || "$1" == "$2"/* ]]
}

generate_operation_identity() {
  local generated_operation
  generated_operation="$(
    od -An -N32 -tx1 /dev/urandom 2>/dev/null | tr -d ' \n'
  )"
  is_operation_identity "$generated_operation" || \
    fail 'deployment-operation-identity-unavailable'
  printf '%s\n' "$generated_operation"
}

repository_root="$(git rev-parse --show-toplevel 2>/dev/null)" || \
  fail 'not-a-git-checkout'
cd "$repository_root"
repository_root="$(pwd -P)" || fail 'checkout-path-unavailable'

git_common_directory="$(git rev-parse --git-common-dir 2>/dev/null)" || \
  fail 'git-directory-unavailable'
if [[ "$git_common_directory" != /* ]]; then
  git_common_directory="${repository_root}/${git_common_directory}"
fi
git_common_directory="$(cd "$git_common_directory" 2>/dev/null && pwd -P)" || \
  fail 'git-directory-unavailable'

lock_file_input="${CLAUDIAN_DEPLOY_LOCK_FILE:-/var/lib/claudian-cloud-server/deploy.lock}"
lock_parent_input="$(dirname "$lock_file_input")"
lock_name="$(basename "$lock_file_input")"
[[ "$lock_name" != '.' && "$lock_name" != '..' ]] || \
  fail 'deployment-lock-unavailable'
lock_parent="$(cd "$lock_parent_input" 2>/dev/null && pwd -P)" || \
  fail 'deployment-lock-unavailable'
deployment_lock_file="${lock_parent}/${lock_name}"
if is_path_within "$deployment_lock_file" "$repository_root" \
    || is_path_within "$deployment_lock_file" "$git_common_directory"; then
  fail 'deployment-lock-inside-checkout'
fi

forward_state_input="${CLAUDIAN_DEPLOY_FORWARD_STATE_FILE:-/var/lib/claudian-cloud-server/deploy-forward}"
forward_state_parent_input="$(dirname "$forward_state_input")"
forward_state_name="$(basename "$forward_state_input")"
[[ "$forward_state_name" != '.' && "$forward_state_name" != '..' ]] || \
  fail 'deployment-forward-state-unavailable'
forward_state_parent="$(
  cd "$forward_state_parent_input" 2>/dev/null && pwd -P
)" || fail 'deployment-forward-state-unavailable'
forward_state_file="${forward_state_parent}/${forward_state_name}"
if is_path_within "$forward_state_file" "$repository_root" \
    || is_path_within "$forward_state_file" "$git_common_directory"; then
  fail 'deployment-forward-state-inside-checkout'
fi
[[ ! -L "$forward_state_file" \
    && ( ! -e "$forward_state_file" || -f "$forward_state_file" ) ]] || \
  fail 'deployment-forward-state-invalid'
deployment_lock_kind=''

release_deployment_lock() {
  local lock_pid=''
  local lock_extra=''
  if [[ "$deployment_lock_kind" == 'flock' ]]; then
    exec 9>&-
  elif [[ "$deployment_lock_kind" == 'shlock' \
      && -f "$deployment_lock_file" \
      && ! -L "$deployment_lock_file" ]]; then
    IFS=' ' read -r lock_pid lock_extra \
      < "$deployment_lock_file" 2>/dev/null || true
    if [[ "$lock_pid" == "$$" && -z "$lock_extra" ]]; then
      rm -f -- "$deployment_lock_file" 2>/dev/null
    fi
  fi
  deployment_lock_kind=''
}

acquire_deployment_lock() {
  [[ ! -L "$deployment_lock_file" \
      && ( ! -e "$deployment_lock_file" || -f "$deployment_lock_file" ) ]] || \
    fail 'deployment-lock-invalid'
  umask 077
  if command -v flock >/dev/null 2>&1; then
    if ! { exec 9>> "$deployment_lock_file"; } 2>/dev/null; then
      fail 'deployment-lock-unavailable'
    fi
    if ! flock --exclusive --nonblock 9 2>/dev/null; then
      exec 9>&-
      fail 'deployment-already-running'
    fi
    deployment_lock_kind='flock'
  elif command -v shlock >/dev/null 2>&1; then
    if ! shlock -f "$deployment_lock_file" -p "$$" 2>/dev/null; then
      fail 'deployment-already-running'
    fi
    deployment_lock_kind='shlock'
  else
    fail 'deployment-lock-mechanism-unavailable'
  fi
  trap release_deployment_lock EXIT
  trap 'exit 129' HUP
  trap 'exit 130' INT
  trap 'exit 143' TERM
}

acquire_deployment_lock

read_forward_state() {
  local marker=''
  local state_revision=''
  local state_image=''
  local state_operation=''
  local extra=''
  [[ -f "$forward_state_file" && ! -L "$forward_state_file" ]] || return 1
  IFS=' ' read -r \
    marker state_revision state_image state_operation extra \
    < "$forward_state_file" 2>/dev/null || return 1
  [[ "$marker" == 'recovery-started' && -z "$extra" ]] || return 1
  is_git_revision "$state_revision" || return 1
  is_image_identity "$state_image" || return 1
  is_operation_identity "$state_operation" || return 1
  printf '%s %s %s\n' "$state_revision" "$state_image" "$state_operation"
}

sync_forward_state() {
  dd if=/dev/null of="$1" conv=notrunc,fsync >/dev/null 2>&1
}

persist_forward_state() {
  local temporary_state
  [[ ! -e "$forward_state_file" && ! -L "$forward_state_file" ]] || return 1
  umask 077
  temporary_state="$(mktemp "${forward_state_file}.tmp.XXXXXX" 2>/dev/null)" || \
    return 1
  if ! printf 'recovery-started %s %s %s\n' \
      "$revision" "$candidate_image" "$operation_id" \
      > "$temporary_state" 2>/dev/null \
      || ! sync_forward_state "$temporary_state" \
      || ! ln "$temporary_state" "$forward_state_file" 2>/dev/null; then
    rm -f -- "$temporary_state" 2>/dev/null
    return 1
  fi
  rm -f -- "$temporary_state" 2>/dev/null
  sync >/dev/null 2>&1
}

discard_forward_state() {
  local observed
  observed="$(read_forward_state)" || return 1
  [[ "$observed" == "$revision $candidate_image $operation_id" ]] || return 1
  rm -- "$forward_state_file" 2>/dev/null || return 1
  sync >/dev/null 2>&1
}

if [[ -n "$(git status --porcelain --untracked-files=all)" ]]; then
  fail 'dirty-checkout'
fi

deployment_ref="${CLAUDIAN_DEPLOY_REF:-origin/main}"
environment_file="${CLAUDIAN_DEPLOY_ENV_FILE:-/etc/claudian-cloud-server/server.env}"
postgres_environment_file="${CLAUDIAN_DEPLOY_POSTGRES_ENV_FILE:-/etc/claudian-cloud-server/postgres.env}"
image_repository="${CLAUDIAN_DEPLOY_IMAGE_REPOSITORY:-claudian-cloud-server}"
wait_timeout="${CLAUDIAN_DEPLOY_WAIT_TIMEOUT_SECONDS:-30}"
build_network="${CLAUDIAN_DEPLOY_BUILD_NETWORK:-}"
compose_project="${CLAUDIAN_DEPLOY_COMPOSE_PROJECT:-claudian-cloud-server}"
postgres_port="${CLAUDIAN_CLOUD_POSTGRES_PORT:-5432}"
compose_file='deploy/compose.yaml'
dockerfile='deploy/Dockerfile'

[[ -r "$environment_file" ]] || fail 'environment-file-unreadable'
[[ -r "$postgres_environment_file" ]] || \
  fail 'postgres-environment-file-unreadable'
[[ "$wait_timeout" =~ ^[1-9][0-9]*$ ]] || fail 'invalid-wait-timeout'
[[ "$compose_project" =~ ^[a-z0-9][a-z0-9_-]{0,62}$ ]] || \
  fail 'invalid-compose-project'
[[ "$postgres_port" =~ ^[1-9][0-9]{0,4}$ ]] || fail 'invalid-postgres-port'

resume_forward=0
if [[ -e "$forward_state_file" || -L "$forward_state_file" ]]; then
  forward_state="$(read_forward_state)" || \
    fail 'deployment-forward-state-invalid'
  IFS=' ' read -r revision candidate_image operation_id <<< "$forward_state"
  resume_forward=1
fi

if [[ $resume_forward -eq 0 ]]; then
  git fetch --prune origin
  revision="$(git rev-parse --verify "${deployment_ref}^{commit}")" || \
    fail 'deployment-ref-not-found'
  is_git_revision "$revision" || fail 'deployment-ref-invalid'
else
  resumed_revision="$(git rev-parse --verify "${revision}^{commit}")" || \
    fail 'deployment-forward-state-invalid'
  [[ "$resumed_revision" == "$revision" ]] || \
    fail 'deployment-forward-state-invalid'
fi
git checkout --detach "$revision"

image_tag="${image_repository}:${revision}"
compose=(docker compose --file "$compose_file" --project-name "$compose_project")
build=(docker build)
if [[ -n "$build_network" ]]; then
  build+=(--network "$build_network")
fi
build+=(
  --build-arg "CLAUDIAN_SERVER_BUILD=$revision"
  --file "$dockerfile"
  --tag "$image_tag"
  .
)

compose_for() {
  local selected_image="$1"
  shift
  CLAUDIAN_CLOUD_ENV_FILE="$environment_file" \
  CLAUDIAN_CLOUD_POSTGRES_ENV_FILE="$postgres_environment_file" \
  CLAUDIAN_CLOUD_IMAGE="$selected_image" \
  CLAUDIAN_CLOUD_POSTGRES_PORT="$postgres_port" \
    "${compose[@]}" "$@"
}

start_server() {
  local selected_image="$1"
  CLAUDIAN_CLOUD_RESTORE_RECOVERY_REQUIRED=false \
  CLAUDIAN_CLOUD_PROJECT_RECOVERY_REQUIRED=false \
    compose_for "$selected_image" up \
      --detach \
      --no-build \
      --no-deps \
      --wait \
      --wait-timeout "$wait_timeout" \
      cloud-server
}

if [[ $resume_forward -eq 1 ]]; then
  compose_for "$candidate_image" config --quiet
  deployment_image="$candidate_image"
  available_image="$(
    docker image inspect --format '{{.Id}}' "$candidate_image"
  )" || fail 'forward-image-unavailable'
  [[ "$available_image" == "$candidate_image" ]] || \
    fail 'forward-image-identity-changed'
else
  compose_for "$image_tag" config --quiet
  deployment_image="$image_tag"
fi
container_id="$(
  compose_for "$deployment_image" ps --all --quiet cloud-server 2>/dev/null \
    || true
)"
[[ -n "$container_id" ]] || fail 'update-requires-running-server'

if [[ $resume_forward -eq 0 ]]; then
  previous_image="$(docker inspect --format '{{.Image}}' "$container_id")" || \
    fail 'previous-image-unavailable'
  is_image_identity "$previous_image" || fail 'previous-image-identity-invalid'

  printf 'deployment.building revision=%s\n' "$revision"
  "${build[@]}"
  candidate_image="$(docker image inspect --format '{{.Id}}' "$image_tag")" || \
    fail 'candidate-image-unavailable'
  is_image_identity "$candidate_image" || fail 'candidate-image-identity-invalid'
  operation_id="$(generate_operation_identity)"

  compose_for "$previous_image" stop cloud-server || fail 'runtime-stop-failed'
  if ! CLAUDIAN_CLOUD_MAINTENANCE_OPERATION_ID="$operation_id" \
      compose_for "$candidate_image" run --rm cloud-verify-authority; then
    start_server "$previous_image" || fail 'previous-image-reopen-failed'
    fail 'candidate-authority-verification-failed'
  fi
  persist_forward_state || fail 'deployment-forward-state-unavailable'
else
  compose_for "$candidate_image" stop cloud-server || fail 'runtime-stop-failed'
fi

CLAUDIAN_CLOUD_RESTORE_RECOVERY_REQUIRED=true \
  compose_for "$candidate_image" run --rm cloud-restore-recovery || \
  fail 'candidate-restore-recovery-failed'

CLAUDIAN_CLOUD_PROJECT_RECOVERY_REQUIRED=true \
  compose_for "$candidate_image" run --rm --no-deps cloud-project-recovery || \
  fail 'candidate-project-recovery-failed'

start_server "$candidate_image" || fail 'candidate-start-failed'
discard_forward_state || fail 'deployment-forward-state-settlement-failed'
printf 'deployment.ready revision=%s image=%s\n' \
  "$revision" "$candidate_image"
