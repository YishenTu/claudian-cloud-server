#!/usr/bin/env bash

set -Eeuo pipefail

fail() {
  printf 'deployment.error: %s\n' "$1" >&2
  exit 1
}

is_image_identity() {
  [[ "$1" =~ ^sha256:[0-9a-f]{64}$ ]]
}

is_schema_version() {
  [[ "$1" =~ ^(0|[1-9][0-9]*)$ ]]
}

is_operation_identity() {
  [[ "$1" =~ ^[0-9a-f]{64}$ ]]
}

is_git_revision() {
  [[ "$1" =~ ^[0-9a-f]{40}$ ]]
}

is_attempt_phase() {
  [[ "$1" == 'backup-active' \
      || "$1" == 'schema-forward' \
      || "$1" == 'forward-only' \
      || "$1" == 'restored-active' ]]
}

is_backup_schema() {
  [[ "$1" == 'pending' ]] || is_schema_version "$1"
}

is_backup_image() {
  [[ "$1" == 'pending' ]] || is_image_identity "$1"
}

is_rollback_proof() {
  [[ "$1" == 'safe' || "$1" == 'probe' ]]
}

is_path_within() {
  [[ "$1" == "$2" || "$1" == "$2"/* ]]
}

repository_root="$(git rev-parse --show-toplevel 2>/dev/null)" || \
  fail 'not-a-git-checkout'
cd "$repository_root"
repository_root="$(pwd -P)" || fail 'checkout-path-unavailable'

attempt_state_file="${CLAUDIAN_DEPLOY_ATTEMPT_STATE_FILE:-/var/lib/claudian-cloud-server/deploy-attempt}"
attempt_state_parent_input="$(dirname "$attempt_state_file")"
attempt_state_name="$(basename "$attempt_state_file")"
[[ "$attempt_state_name" != '.' && "$attempt_state_name" != '..' ]] || \
  fail 'deployment-attempt-state-unavailable'
attempt_state_parent="$(cd "$attempt_state_parent_input" 2>/dev/null && pwd -P)" || \
  fail 'deployment-attempt-state-unavailable'
attempt_state_file="${attempt_state_parent}/${attempt_state_name}"

git_common_directory="$(git rev-parse --git-common-dir 2>/dev/null)" || \
  fail 'git-directory-unavailable'
if [[ "$git_common_directory" != /* ]]; then
  git_common_directory="${repository_root}/${git_common_directory}"
fi
git_common_directory="$(cd "$git_common_directory" 2>/dev/null && pwd -P)" || \
  fail 'git-directory-unavailable'
if is_path_within "$attempt_state_file" "$repository_root" \
    || is_path_within "$attempt_state_file" "$git_common_directory"; then
  fail 'deployment-attempt-state-inside-checkout'
fi
[[ ! -L "$attempt_state_file" ]] || fail 'deployment-attempt-state-invalid'

deployment_lock_file="${attempt_state_file}.lock"
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

if [[ -n "$(git status --porcelain --untracked-files=all)" ]]; then
  fail 'dirty-checkout'
fi

deployment_ref="${CLAUDIAN_DEPLOY_REF:-origin/main}"
environment_file="${CLAUDIAN_DEPLOY_ENV_FILE:-/etc/claudian-cloud-server/server.env}"
migration_environment_file="${CLAUDIAN_DEPLOY_MIGRATION_ENV_FILE:-/etc/claudian-cloud-server/migration.env}"
postgres_environment_file="${CLAUDIAN_DEPLOY_POSTGRES_ENV_FILE:-/etc/claudian-cloud-server/postgres.env}"
image_repository="${CLAUDIAN_DEPLOY_IMAGE_REPOSITORY:-claudian-cloud-server}"
wait_timeout="${CLAUDIAN_DEPLOY_WAIT_TIMEOUT_SECONDS:-30}"
build_network="${CLAUDIAN_DEPLOY_BUILD_NETWORK:-}"
failure_mode="${CLAUDIAN_DEPLOY_FAILURE_MODE:-fixed-forward}"
compose_project="${CLAUDIAN_DEPLOY_COMPOSE_PROJECT:-claudian-cloud-server}"
postgres_port="${CLAUDIAN_CLOUD_POSTGRES_PORT:-5432}"
restore_compose_project="${CLAUDIAN_DEPLOY_RESTORE_COMPOSE_PROJECT:-}"
restore_bootstrap_environment_file="${CLAUDIAN_DEPLOY_RESTORE_BOOTSTRAP_ENV_FILE:-}"
restore_environment_file="${CLAUDIAN_DEPLOY_RESTORE_ENV_FILE:-}"
restore_migration_environment_file="${CLAUDIAN_DEPLOY_RESTORE_MIGRATION_ENV_FILE:-}"
restore_postgres_environment_file="${CLAUDIAN_DEPLOY_RESTORE_POSTGRES_ENV_FILE:-}"
restore_postgres_port="${CLAUDIAN_DEPLOY_RESTORE_POSTGRES_PORT:-}"
restore_ownership_id="${CLAUDIAN_DEPLOY_RESTORE_OWNERSHIP_ID:-}"
compose_file='deploy/compose.yaml'
dockerfile='deploy/Dockerfile'

[[ -r "$environment_file" ]] || fail 'environment-file-unreadable'
[[ -r "$migration_environment_file" ]] || \
  fail 'migration-environment-file-unreadable'
[[ -r "$postgres_environment_file" ]] || \
  fail 'postgres-environment-file-unreadable'
[[ "$wait_timeout" =~ ^[1-9][0-9]*$ ]] || fail 'invalid-wait-timeout'
[[ "$failure_mode" == 'fixed-forward' || "$failure_mode" == 'restore' ]] || \
  fail 'invalid-failure-mode'
[[ "$compose_project" =~ ^[a-z0-9][a-z0-9_-]{0,62}$ ]] || \
  fail 'invalid-compose-project'
[[ "$postgres_port" =~ ^[1-9][0-9]{0,4}$ ]] || fail 'invalid-postgres-port'
command -v dd >/dev/null 2>&1 || fail 'durable-state-tool-unavailable'
command -v sync >/dev/null 2>&1 || fail 'durable-state-tool-unavailable'
[[ -n "$restore_compose_project" \
      && "$restore_compose_project" != "$compose_project" \
      && "$restore_compose_project" =~ ^[a-z0-9][a-z0-9_-]{0,62}$ \
      && -r "$restore_bootstrap_environment_file" \
      && -r "$restore_environment_file" \
      && -r "$restore_migration_environment_file" \
      && -r "$restore_postgres_environment_file" \
      && "$restore_environment_file" != "$environment_file" \
      && "$restore_bootstrap_environment_file" != "$environment_file" \
      && "$restore_migration_environment_file" != "$migration_environment_file" \
      && "$restore_postgres_environment_file" != "$postgres_environment_file" \
      && "$restore_postgres_port" =~ ^[1-9][0-9]{0,4}$ \
      && "$restore_postgres_port" != "$postgres_port" \
      && "$restore_ownership_id" =~ ^[0-9a-f]{64}$ ]] || \
  fail 'restore-target-required'

git fetch --prune origin
revision="$(git rev-parse --verify "${deployment_ref}^{commit}")" || \
  fail 'deployment-ref-not-found'
git checkout --detach "$revision"

operation_id=''
attempt_phase=''
backup_schema=''
backup_image=''
rollback_proof=''
image_tag="${image_repository}:${revision}"
compose=(docker compose --file "$compose_file")
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
  CLAUDIAN_CLOUD_BOOTSTRAP_MODE=authority \
  CLAUDIAN_CLOUD_MIGRATION_ENV_FILE="$migration_environment_file" \
  CLAUDIAN_CLOUD_POSTGRES_ENV_FILE="$postgres_environment_file" \
  CLAUDIAN_CLOUD_IMAGE="$selected_image" \
  CLAUDIAN_CLOUD_MAINTENANCE_OPERATION_ID="$operation_id" \
  CLAUDIAN_CLOUD_POSTGRES_PORT="$postgres_port" \
  CLAUDIAN_CLOUD_RESTORE_RECOVERY_REQUIRED="${CLAUDIAN_CLOUD_RESTORE_RECOVERY_REQUIRED:-true}" \
    "${compose[@]}" --project-name "$compose_project" "$@"
}

restore_compose_for() {
  local selected_image="$1"
  shift
  CLAUDIAN_CLOUD_ENV_FILE="$restore_environment_file" \
  CLAUDIAN_CLOUD_BOOTSTRAP_MODE=restore-target \
  CLAUDIAN_CLOUD_BOOTSTRAP_ENV_FILE="$restore_bootstrap_environment_file" \
  CLAUDIAN_CLOUD_MIGRATION_ENV_FILE="$restore_migration_environment_file" \
  CLAUDIAN_CLOUD_POSTGRES_ENV_FILE="$restore_postgres_environment_file" \
  CLAUDIAN_CLOUD_IMAGE="$selected_image" \
  CLAUDIAN_CLOUD_MAINTENANCE_OPERATION_ID="$operation_id" \
  CLAUDIAN_CLOUD_POSTGRES_PORT="$restore_postgres_port" \
  CLAUDIAN_CLOUD_RESTORE_OWNERSHIP_ID="$restore_ownership_id" \
  CLAUDIAN_CLOUD_RESTORE_RECOVERY_REQUIRED="${CLAUDIAN_CLOUD_RESTORE_RECOVERY_REQUIRED:-true}" \
    "${compose[@]}" --project-name "$restore_compose_project" "$@"
}

start_image() {
  local selected_image="$1"
  local recovery_required="$2"
  if [[ "$recovery_required" == 'true' ]]; then
    CLAUDIAN_CLOUD_RESTORE_RECOVERY_REQUIRED=true \
      compose_for "$selected_image" run --rm cloud-restore-recovery || return 1
    CLAUDIAN_CLOUD_PROJECT_RECOVERY_REQUIRED=true \
      compose_for "$selected_image" run --rm --no-deps \
      cloud-project-recovery || return 1
  elif [[ "$recovery_required" != 'false' ]]; then
    return 1
  fi
  CLAUDIAN_CLOUD_RESTORE_RECOVERY_REQUIRED=false \
    CLAUDIAN_CLOUD_PROJECT_RECOVERY_REQUIRED=false \
    compose_for "$selected_image" up \
    --detach \
    --no-build \
    --wait \
    --wait-timeout "$wait_timeout"
}

start_restored_image() {
  local selected_image="$1"
  local recovery_required="$2"
  if [[ "$recovery_required" == 'true' ]]; then
    CLAUDIAN_CLOUD_RESTORE_RECOVERY_REQUIRED=true \
      restore_compose_for "$selected_image" run --rm cloud-restore-recovery || return 1
    CLAUDIAN_CLOUD_PROJECT_RECOVERY_REQUIRED=true \
      restore_compose_for "$selected_image" run --rm --no-deps \
      cloud-project-recovery || return 1
  elif [[ "$recovery_required" != 'false' ]]; then
    return 1
  fi
  CLAUDIAN_CLOUD_RESTORE_RECOVERY_REQUIRED=false \
    CLAUDIAN_CLOUD_PROJECT_RECOVERY_REQUIRED=false \
    restore_compose_for "$selected_image" up \
    --detach \
    --no-build \
    --wait \
    --wait-timeout "$wait_timeout"
}

image_schema_target() {
  docker run \
    --rm \
    --read-only \
    --user 10001:10001 \
    --cap-drop ALL \
    --security-opt no-new-privileges \
    --entrypoint node \
    "$1" \
    dist/migrate.js target
}

image_supports_schema() {
  docker run \
    --rm \
    --read-only \
    --user 10001:10001 \
    --cap-drop ALL \
    --security-opt no-new-privileges \
    --entrypoint node \
    "$1" \
    dist/migrate.js supports "$2" \
    >/dev/null 2>&1
}

read_current_schema() {
  compose_for "$1" run --rm \
    cloud-migration node dist/migrate.js preflight
}

run_maintenance() {
  local selected_image="$1"
  shift
  compose_for "$selected_image" run --rm "$@"
}

recover_failed_backup() {
  local selected_image="$1"
  if run_maintenance "$selected_image" --no-deps cloud-project-recovery; then
    return 0
  fi
  run_maintenance "$selected_image" cloud-backup
}

read_restored_schema() {
  restore_compose_for "$1" run --rm \
    cloud-migration node dist/migrate.js preflight
}

run_restore_maintenance() {
  local selected_image="$1"
  shift
  restore_compose_for "$selected_image" run --rm "$@"
}

reset_restore_target() {
  local selected_image="$1"
  restore_target_is_owned_or_empty "$selected_image" || return 1
  restore_compose_for "$selected_image" down \
    --volumes --remove-orphans >/dev/null 2>&1 || return 1
  restore_compose_for "$selected_image" up \
    --detach \
    --no-build \
    --wait \
    --wait-timeout "$wait_timeout" \
    postgres || return 1
  restore_compose_for "$selected_image" run --rm cloud-bootstrap
}

discard_restore_target() {
  restore_target_is_owned_or_empty "$1" || return 1
  restore_compose_for "$1" down \
    --volumes --remove-orphans >/dev/null 2>&1
}

restore_target_is_owned_or_empty() {
  local selected_image="$1"
  local owned_volume_count=0
  local owner=''
  local volume=''
  local volume_inventory=''
  volume_inventory="$(docker volume ls --format '{{.Name}}' 2>/dev/null)" || \
    return 1
  for volume in \
    "${restore_compose_project}_cloud-authority" \
    "${restore_compose_project}_postgres-data"; do
    local observed_volume=''
    local volume_present=0
    while IFS= read -r observed_volume; do
      if [[ "$observed_volume" == "$volume" ]]; then
        volume_present=1
        break
      fi
    done <<< "$volume_inventory"
    if [[ $volume_present -eq 1 ]]; then
      owner="$(docker volume inspect \
        --format '{{ index .Labels "com.claudian.restore-owner" }}' \
        "$volume" 2>/dev/null)" || return 1
      [[ "$owner" == "$restore_ownership_id" ]] || return 1
      owned_volume_count=$((owned_volume_count + 1))
    fi
  done
  local containers=''
  containers="$(restore_compose_for "$selected_image" \
    ps --all --quiet 2>/dev/null)" || return 1
  local container=''
  if [[ -n "$containers" && $owned_volume_count -eq 0 ]]; then
    return 1
  fi
  while IFS= read -r container; do
    [[ -z "$container" ]] && continue
    owner="$(docker inspect \
      --format '{{ index .Config.Labels "com.claudian.restore-owner" }}' \
      "$container" 2>/dev/null)" || return 1
    [[ "$owner" == "$restore_ownership_id" ]] || return 1
  done <<< "$containers"
}

sync_attempt_file() {
  dd if=/dev/null of="$1" conv=notrunc,fsync >/dev/null 2>&1
}

sync_attempt_directory() {
  sync >/dev/null 2>&1
}

read_attempt_state() {
  local state_phase=''
  local state_revision=''
  local state_operation=''
  local state_backup_schema=''
  local state_backup_image=''
  local state_rollback_proof=''
  local state_extra=''
  [[ -f "$attempt_state_file" && ! -L "$attempt_state_file" ]] || return 1
  IFS=' ' read -r \
    state_phase \
    state_revision \
    state_operation \
    state_backup_schema \
    state_rollback_proof \
    state_backup_image \
    state_extra < "$attempt_state_file" 2>/dev/null || return 1
  [[ -z "$state_extra" ]] || return 1
  is_attempt_phase "$state_phase" || return 1
  is_git_revision "$state_revision" || return 1
  is_operation_identity "$state_operation" || return 1
  is_backup_schema "$state_backup_schema" || return 1
  is_rollback_proof "$state_rollback_proof" || return 1
  is_backup_image "$state_backup_image" || return 1
  if [[ "$state_backup_schema" == 'pending' \
      && "$state_backup_image" != 'pending' ]]; then
    return 1
  fi
  if [[ "$state_backup_image" == 'pending' \
      && "$state_phase" != 'backup-active' \
      && "$state_phase" != 'forward-only' ]]; then
    return 1
  fi
  if [[ "$state_backup_schema" == 'pending' \
      && "$state_phase" != 'backup-active' ]]; then
    return 1
  fi
  if [[ "$state_phase" == 'backup-active' \
      && "$state_rollback_proof" != 'safe' ]]; then
    return 1
  fi
  if [[ ( "$state_phase" == 'forward-only' \
        || "$state_phase" == 'restored-active' ) \
      && "$state_rollback_proof" != 'probe' ]]; then
    return 1
  fi
  printf '%s %s %s %s %s %s\n' \
    "$state_phase" \
    "$state_revision" \
    "$state_operation" \
    "$state_backup_schema" \
    "$state_rollback_proof" \
    "$state_backup_image"
}

generate_operation_identity() {
  local generated_operation
  generated_operation="$(
    od -An -N32 -tx1 /dev/urandom 2>/dev/null | tr -d ' \n'
  )"
  is_operation_identity "$generated_operation" || \
    fail 'deployment-attempt-identity-unavailable'
  printf '%s\n' "$generated_operation"
}

create_or_resume_attempt() {
  local state_parent
  local temporary_state
  local generated_operation
  if [[ -e "$attempt_state_file" || -L "$attempt_state_file" ]]; then
    read_attempt_state || fail 'deployment-attempt-state-invalid'
    return
  fi
  state_parent="$(dirname "$attempt_state_file")"
  [[ -d "$state_parent" && -w "$state_parent" ]] || \
    fail 'deployment-attempt-state-unavailable'
  generated_operation="$(generate_operation_identity)"
  umask 077
  temporary_state="$(mktemp "${attempt_state_file}.tmp.XXXXXX" 2>/dev/null)" || \
    fail 'deployment-attempt-state-unavailable'
  if ! printf 'backup-active %s %s pending safe pending\n' \
    "$revision" \
    "$generated_operation" > "$temporary_state" 2>/dev/null; then
    rm -f -- "$temporary_state" 2>/dev/null
    fail 'deployment-attempt-state-unavailable'
  fi
  if ! sync_attempt_file "$temporary_state"; then
    rm -f -- "$temporary_state" 2>/dev/null
    fail 'deployment-attempt-state-unavailable'
  fi
  if ln "$temporary_state" "$attempt_state_file" 2>/dev/null; then
    rm -f -- "$temporary_state" 2>/dev/null
    sync_attempt_directory || fail 'deployment-attempt-state-unavailable'
    printf 'backup-active %s %s pending safe pending\n' \
      "$revision" \
      "$generated_operation"
    return
  fi
  rm -f -- "$temporary_state" 2>/dev/null
  read_attempt_state || fail 'deployment-attempt-state-conflict'
}

replace_attempt_state() {
  local expected_phase="$1"
  local next_phase="$2"
  local next_operation="$3"
  local next_backup_schema="$4"
  local next_rollback_proof="$5"
  local next_backup_image="$6"
  local observed_phase=''
  local observed_revision=''
  local observed_operation=''
  local observed_backup_schema=''
  local observed_rollback_proof=''
  local observed_backup_image=''
  local temporary_state
  IFS=' ' read -r \
    observed_phase \
    observed_revision \
    observed_operation \
    observed_backup_schema \
    observed_rollback_proof \
    observed_backup_image \
    <<< "$(read_attempt_state)" || return 1
  [[ "$observed_phase" == "$expected_phase" \
      && "$observed_operation" == "$operation_id" \
      && "$observed_backup_schema" == "$backup_schema" \
      && "$observed_rollback_proof" == "$rollback_proof" \
      && "$observed_backup_image" == "$backup_image" ]] || return 1
  is_attempt_phase "$next_phase" || return 1
  is_operation_identity "$next_operation" || return 1
  is_backup_schema "$next_backup_schema" || return 1
  is_rollback_proof "$next_rollback_proof" || return 1
  is_backup_image "$next_backup_image" || return 1
  if [[ "$next_backup_schema" == 'pending' \
      && "$next_backup_image" != 'pending' ]]; then
    return 1
  fi
  if [[ "$next_backup_image" == 'pending' \
      && "$next_phase" != 'backup-active' \
      && "$next_phase" != 'forward-only' ]]; then
    return 1
  fi
  if [[ "$next_backup_schema" == 'pending' \
      && "$next_phase" != 'backup-active' ]]; then
    return 1
  fi
  if [[ "$next_phase" == 'backup-active' \
      && "$next_rollback_proof" != 'safe' ]]; then
    return 1
  fi
  if [[ ( "$next_phase" == 'forward-only' \
        || "$next_phase" == 'restored-active' ) \
      && "$next_rollback_proof" != 'probe' ]]; then
    return 1
  fi
  temporary_state="$(mktemp "${attempt_state_file}.tmp.XXXXXX" 2>/dev/null)" || \
    return 1
  if ! printf '%s %s %s %s %s %s\n' \
    "$next_phase" \
    "$revision" \
    "$next_operation" \
    "$next_backup_schema" \
    "$next_rollback_proof" \
    "$next_backup_image" > "$temporary_state" 2>/dev/null; then
    rm -f -- "$temporary_state" 2>/dev/null
    return 1
  fi
  if ! sync_attempt_file "$temporary_state"; then
    rm -f -- "$temporary_state" 2>/dev/null
    return 1
  fi
  if ! mv -- "$temporary_state" "$attempt_state_file" 2>/dev/null; then
    rm -f -- "$temporary_state" 2>/dev/null
    return 1
  fi
  sync_attempt_directory || return 1
  attempt_phase="$next_phase"
  operation_id="$next_operation"
  backup_schema="$next_backup_schema"
  rollback_proof="$next_rollback_proof"
  backup_image="$next_backup_image"
}

discard_attempt_state() {
  local observed_phase=''
  local observed_revision=''
  local observed_operation=''
  local observed_backup_schema=''
  local observed_rollback_proof=''
  local observed_backup_image=''
  IFS=' ' read -r \
    observed_phase \
    observed_revision \
    observed_operation \
    observed_backup_schema \
    observed_rollback_proof \
    observed_backup_image \
    <<< "$(read_attempt_state)" || return 1
  [[ "$observed_phase" == "$attempt_phase" \
      && "$observed_operation" == "$operation_id" \
      && "$observed_backup_schema" == "$backup_schema" \
      && "$observed_rollback_proof" == "$rollback_proof" \
      && "$observed_backup_image" == "$backup_image" ]] || return 1
  rm -- "$attempt_state_file" 2>/dev/null || return 1
  sync_attempt_directory || return 1
  attempt_phase=''
}

rollback_before_advancement() {
  local reason="$1"
  [[ "$attempt_phase" == 'backup-active' ]] || fail "$reason"
  printf 'deployment.rolling-back\n' >&2
  discard_attempt_state || fail 'deployment-attempt-state-settlement-failed'
  if ! start_image "$previous_image" false; then
    fail 'replacement-and-rollback-failed'
  fi
  printf 'deployment.rolled-back\n' >&2
  fail "$reason"
}

rollback_to_compatible_previous() {
  local reason="$1"
  local observed_schema="$2"
  image_supports_schema "$previous_image" "$observed_schema" || fail "$reason"
  printf 'deployment.rolling-back-compatible-image\n' >&2
  discard_attempt_state || fail 'deployment-attempt-state-settlement-failed'
  if ! start_image "$previous_image" false; then
    fail 'replacement-and-rollback-failed'
  fi
  printf 'deployment.rolled-back-compatible-image\n' >&2
  fail "$reason"
}

rollback_to_verified_previous() {
  local reason="$1"
  local observed_schema="$2"
  [[ "$attempt_phase" == 'schema-forward' \
      && "$rollback_proof" == 'safe' \
      && "$observed_schema" == "$backup_schema" ]] || fail "$reason"
  printf 'deployment.rolling-back-verified-image\n' >&2
  discard_attempt_state || fail 'deployment-attempt-state-settlement-failed'
  if ! start_image "$previous_image" false; then
    fail 'replacement-and-rollback-failed'
  fi
  printf 'deployment.rolled-back-verified-image\n' >&2
  fail "$reason"
}

if [[ -e "$attempt_state_file" || -L "$attempt_state_file" ]]; then
  existing_attempt_state="$(read_attempt_state)" || \
    fail 'deployment-attempt-state-invalid'
  existing_attempt_phase=''
  existing_attempt_revision=''
  existing_attempt_operation=''
  existing_backup_schema=''
  existing_rollback_proof=''
  existing_backup_image=''
  IFS=' ' read -r \
    existing_attempt_phase \
    existing_attempt_revision \
    existing_attempt_operation \
    existing_backup_schema \
    existing_rollback_proof \
    existing_backup_image <<< "$existing_attempt_state"
  if [[ "$existing_attempt_phase" == 'restored-active' ]]; then
    fail 'restored-authority-active'
  fi
fi

compose_for "$image_tag" config --quiet

container_id="$(
  compose_for "$image_tag" ps --all --quiet cloud-server 2>/dev/null || true
)"
[[ -n "$container_id" ]] || fail 'upgrade-requires-running-server'
previous_image="$(docker inspect --format '{{.Image}}' "$container_id")" || \
  fail 'previous-image-unavailable'
is_image_identity "$previous_image" || fail 'previous-image-identity-invalid'

printf 'deployment.building revision=%s\n' "$revision"
"${build[@]}"
candidate_image="$(docker image inspect --format '{{.Id}}' "$image_tag")" || \
  fail 'candidate-image-unavailable'
is_image_identity "$candidate_image" || fail 'candidate-image-identity-invalid'

target_schema="$(image_schema_target "$candidate_image")" || \
  fail 'candidate-schema-probe-failed'
is_schema_version "$target_schema" || fail 'candidate-schema-probe-invalid'

attempt_state="$(create_or_resume_attempt)"
attempt_revision=''
IFS=' ' read -r \
  attempt_phase \
  attempt_revision \
  operation_id \
  backup_schema \
  rollback_proof \
  backup_image <<< "$attempt_state"
if ! compose_for "$previous_image" stop cloud-server; then
  if [[ "$attempt_phase" == 'backup-active' ]]; then
    discard_attempt_state || fail 'deployment-attempt-state-settlement-failed'
  fi
  fail 'runtime-stop-failed'
fi

if [[ "$attempt_phase" == 'forward-only' ]]; then
  if start_image "$candidate_image" true; then
    discard_attempt_state || fail 'deployment-attempt-state-settlement-failed'
    printf 'deployment.ready revision=%s image=%s\n' \
      "$revision" "$candidate_image"
    exit 0
  fi
  compose_for "$candidate_image" stop cloud-server >/dev/null 2>&1 || \
    fail 'forward-recovery-runtime-stop-failed'
  recovery_schema="$(read_current_schema "$candidate_image")" || \
    fail 'forward-recovery-schema-unknown'
  is_schema_version "$recovery_schema" || \
    fail 'forward-recovery-schema-invalid'
  previous_supports_recovery=0
  if image_supports_schema "$previous_image" "$recovery_schema"; then
    previous_supports_recovery=1
  fi
  if image_supports_schema "$candidate_image" "$recovery_schema"; then
    selected_backup_image="$candidate_image"
  elif [[ $previous_supports_recovery -eq 1 ]]; then
    selected_backup_image="$previous_image"
  else
    fail 'forward-recovery-schema-unsupported'
  fi
  next_operation_id="$(generate_operation_identity)"
  replace_attempt_state \
    'forward-only' \
    'forward-only' \
    "$next_operation_id" \
    "$backup_schema" \
    'probe' \
    'pending' || \
    fail 'deployment-attempt-state-settlement-failed'
  if ! run_maintenance "$selected_backup_image" cloud-backup; then
    recover_failed_backup "$selected_backup_image" || \
      fail 'forward-recovery-backup-recovery-failed'
    if [[ $previous_supports_recovery -eq 1 ]]; then
      rollback_to_compatible_previous 'backup-failed' "$recovery_schema"
    fi
    fail 'forward-recovery-backup-failed'
  fi
  if ! reset_restore_target "$selected_backup_image"; then
    discard_restore_target "$selected_backup_image" >/dev/null 2>&1 || true
    if [[ $previous_supports_recovery -eq 1 ]]; then
      rollback_to_compatible_previous \
        'backup-restore-target-provision-failed' \
        "$recovery_schema"
    fi
    fail 'forward-recovery-backup-restore-target-provision-failed'
  fi
  if ! run_restore_maintenance "$selected_backup_image" cloud-verify-backup; then
    discard_restore_target "$selected_backup_image" >/dev/null 2>&1 || true
    if [[ $previous_supports_recovery -eq 1 ]]; then
      rollback_to_compatible_previous \
        'backup-verification-failed' \
        "$recovery_schema"
    fi
    fail 'forward-recovery-backup-verification-failed'
  fi
  restored_schema="$(read_restored_schema "$selected_backup_image")" || {
    discard_restore_target "$selected_backup_image" >/dev/null 2>&1 || true
    fail 'forward-recovery-backup-schema-unavailable'
  }
  if [[ "$restored_schema" != "$recovery_schema" ]]; then
    discard_restore_target "$selected_backup_image" >/dev/null 2>&1 || true
    fail 'forward-recovery-backup-schema-mismatch'
  fi
  if ! run_restore_maintenance "$selected_backup_image" cloud-verify-authority; then
    discard_restore_target "$selected_backup_image" >/dev/null 2>&1 || true
    fail 'forward-recovery-backup-authority-verification-failed'
  fi
  if ! discard_restore_target "$selected_backup_image"; then
    fail 'forward-recovery-backup-cleanup-failed'
  fi
  recovery_next_phase='schema-forward'
  if [[ $previous_supports_recovery -eq 1 ]]; then
    recovery_next_phase='backup-active'
  fi
  recovery_rollback_proof='probe'
  if [[ $previous_supports_recovery -eq 1 ]]; then
    recovery_rollback_proof='safe'
  fi
  replace_attempt_state \
    'forward-only' \
    "$recovery_next_phase" \
    "$operation_id" \
    "$recovery_schema" \
    "$recovery_rollback_proof" \
    "$selected_backup_image" || \
    fail 'deployment-attempt-state-settlement-failed'
elif [[ "$attempt_phase" == 'backup-active' ]]; then
  observed_backup_schema="$(read_current_schema "$candidate_image")" || \
    rollback_before_advancement 'backup-schema-unknown'
  is_schema_version "$observed_backup_schema" || \
    rollback_before_advancement 'backup-schema-invalid'
  if [[ "$backup_schema" != 'pending' \
      && "$backup_schema" != "$observed_backup_schema" ]]; then
    fail 'backup-schema-changed'
  fi
  if [[ "$backup_schema" == 'pending' ]]; then
    if image_supports_schema "$candidate_image" "$observed_backup_schema"; then
      selected_backup_image="$candidate_image"
    elif image_supports_schema "$previous_image" "$observed_backup_schema"; then
      selected_backup_image="$previous_image"
    else
      rollback_before_advancement 'backup-schema-unsupported'
    fi
    if ! run_maintenance "$selected_backup_image" cloud-backup; then
      recover_failed_backup "$selected_backup_image" || \
        fail 'backup-recovery-failed'
      rollback_before_advancement 'backup-failed'
    fi
    if ! reset_restore_target "$selected_backup_image"; then
      discard_restore_target "$selected_backup_image" >/dev/null 2>&1 || true
      rollback_before_advancement 'backup-restore-target-provision-failed'
    fi
    if ! run_restore_maintenance "$selected_backup_image" cloud-verify-backup; then
      discard_restore_target "$selected_backup_image" >/dev/null 2>&1 || true
      rollback_before_advancement 'backup-verification-failed'
    fi
    restored_schema="$(read_restored_schema "$selected_backup_image")" || {
      discard_restore_target "$selected_backup_image" >/dev/null 2>&1 || true
      rollback_before_advancement 'backup-clean-restore-schema-unavailable'
    }
    if [[ "$restored_schema" != "$observed_backup_schema" ]]; then
      discard_restore_target "$selected_backup_image" >/dev/null 2>&1 || true
      rollback_before_advancement 'backup-clean-restore-schema-mismatch'
    fi
    if ! run_restore_maintenance "$selected_backup_image" cloud-verify-authority; then
      discard_restore_target "$selected_backup_image" >/dev/null 2>&1 || true
      rollback_before_advancement 'backup-clean-restore-verification-failed'
    fi
    if ! discard_restore_target "$selected_backup_image"; then
      rollback_before_advancement 'backup-clean-restore-cleanup-failed'
    fi
    replace_attempt_state \
      'backup-active' \
      'backup-active' \
      "$operation_id" \
      "$observed_backup_schema" \
      'safe' \
      "$selected_backup_image" || \
      fail 'deployment-attempt-state-settlement-failed'
  fi
elif [[ "$attempt_phase" != 'schema-forward' ]]; then
  fail 'deployment-attempt-state-invalid'
fi

before_schema="$(read_current_schema "$candidate_image")" || \
  rollback_before_advancement 'candidate-preflight-failed'
is_schema_version "$before_schema" || \
  rollback_before_advancement 'candidate-preflight-invalid'
if (( before_schema < backup_schema )); then
  fail 'candidate-schema-regressed-below-backup'
fi
if (( before_schema > target_schema )); then
  rollback_before_advancement 'candidate-schema-older-than-database'
fi

previous_supports_target=0
if image_supports_schema "$previous_image" "$target_schema"; then
  previous_supports_target=1
fi

if [[ "$attempt_phase" == 'backup-active' ]]; then
  replace_attempt_state \
    'backup-active' \
    'schema-forward' \
    "$operation_id" \
    "$backup_schema" \
    "$rollback_proof" \
    "$backup_image" || \
    fail 'deployment-attempt-state-settlement-failed'
fi
[[ "$attempt_phase" == 'schema-forward' ]] || \
  fail 'deployment-attempt-state-invalid'

set +e
compose_for "$candidate_image" run --rm cloud-migration
migration_status=$?
set -e

after_schema="$(read_current_schema "$candidate_image")" || \
  fail 'migration-state-unknown'
is_schema_version "$after_schema" || fail 'migration-state-invalid'

if [[ $migration_status -ne 0 ]]; then
  if [[ "$after_schema" == "$before_schema" ]]; then
    if [[ "$rollback_proof" == 'safe' \
        && "$after_schema" == "$backup_schema" ]]; then
      rollback_to_verified_previous \
        'migration-failed-before-schema-advancement' \
        "$after_schema"
    fi
    rollback_to_compatible_previous \
      'migration-failed-before-schema-advancement' \
      "$after_schema"
  fi
  if (( after_schema < before_schema )); then
    fail 'migration-schema-regressed'
  fi
  set +e
  compose_for "$candidate_image" run --rm cloud-migration
  migration_status=$?
  set -e
  after_schema="$(read_current_schema "$candidate_image")" || \
    fail 'fixed-forward-state-unknown'
  is_schema_version "$after_schema" || fail 'fixed-forward-state-invalid'
  if [[ $migration_status -ne 0 || "$after_schema" != "$target_schema" ]]; then
    if image_supports_schema "$previous_image" "$after_schema"; then
      rollback_to_compatible_previous \
        'migration-failed-after-compatible-schema-advancement' \
        "$after_schema"
    fi
    fail 'migration-fixed-forward-required'
  fi
else
  if [[ "$after_schema" != "$target_schema" ]]; then
    fail 'migration-target-mismatch'
  fi
fi

candidate_status=0
set +e
run_maintenance "$candidate_image" cloud-verify-authority
candidate_status=$?
set -e
if [[ $candidate_status -eq 0 ]]; then
  replace_attempt_state \
    'schema-forward' \
    'forward-only' \
    "$operation_id" \
    "$backup_schema" \
    'probe' \
    "$backup_image" || \
    fail 'deployment-attempt-state-settlement-failed'
  set +e
  start_image "$candidate_image" true
  candidate_status=$?
  set -e
fi

if [[ $candidate_status -eq 0 ]]; then
  if ! discard_attempt_state; then
    compose_for "$candidate_image" stop cloud-server >/dev/null 2>&1 || true
    fail 'deployment-attempt-state-settlement-failed'
  fi
  printf 'deployment.ready revision=%s image=%s\n' \
    "$revision" "$candidate_image"
  exit 0
fi

printf 'deployment.unhealthy revision=%s\n' "$revision" >&2
compose_for "$candidate_image" stop cloud-server >/dev/null 2>&1 || true

if [[ "$attempt_phase" == 'schema-forward' \
    && "$rollback_proof" == 'safe' \
    && "$after_schema" == "$backup_schema" ]]; then
  rollback_to_verified_previous \
    'candidate-failed-before-schema-advancement' \
    "$after_schema"
fi

if [[ $previous_supports_target -eq 1 ]]; then
  rollback_to_compatible_previous \
    'candidate-failed-after-compatible-schema-advancement' \
    "$after_schema"
fi

if [[ "$failure_mode" == 'restore' ]]; then
  if ! reset_restore_target "$backup_image"; then
    fail 'restore-target-provision-failed'
  fi
  if ! run_restore_maintenance "$backup_image" cloud-restore; then
    discard_restore_target "$backup_image" >/dev/null 2>&1 || true
    fail 'verified-backup-restore-failed'
  fi
  restored_schema="$(read_restored_schema "$backup_image")" || \
    fail 'restored-schema-unavailable'
  if [[ "$restored_schema" != "$backup_schema" ]]; then
    fail 'restored-schema-mismatch'
  fi
  if ! image_supports_schema "$previous_image" "$restored_schema"; then
    fail 'restored-schema-unsupported-by-previous-image'
  fi
  if ! run_restore_maintenance "$backup_image" cloud-verify-authority; then
    fail 'restored-authority-verification-failed'
  fi
  replace_attempt_state \
    "$attempt_phase" \
    'restored-active' \
    "$operation_id" \
    "$backup_schema" \
    'probe' \
    "$backup_image" || \
    fail 'deployment-attempt-state-settlement-failed'
  if ! start_restored_image "$previous_image" false; then
    fail 'restored-image-start-failed'
  fi
  printf 'deployment.restored-backup\n' >&2
  exit 1
fi

fail 'candidate-failed-after-schema-advancement'
