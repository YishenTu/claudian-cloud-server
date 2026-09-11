#!/usr/bin/env bash

# Sourced by deploy.sh; release acquisition and activation share its update fence.
release_resolve_current() {
  release_cache="${forward_state_file}.releases"
  release_current_file="${forward_state_file}.current-release"
  release_current_root="$repository_root"
  local marker='' current_operation='' extra=''
  [[ ! -L "$release_cache" && ( ! -e "$release_cache" || -d "$release_cache" ) ]] || \
    fail 'release-cache-invalid'
  [[ ! -L "$release_current_file" && ( ! -e "$release_current_file" || -f "$release_current_file" ) ]] || \
    fail 'release-current-invalid'
  if [[ -f "$release_current_file" ]]; then
    IFS=' ' read -r marker current_operation extra < "$release_current_file" || \
      fail 'release-current-invalid'
    [[ "$marker" == 'release-current-v1' && -z "$extra" \
      && "$(wc -l < "$release_current_file")" -eq 1 ]] || fail 'release-current-invalid'
    is_operation_identity "$current_operation" || fail 'release-current-invalid'
    release_current_root="$release_cache/$current_operation/claudian-cloud-server"
  fi
  [[ -d "$release_current_root" && ! -L "$release_current_root" \
    && -r "$release_current_root/release.env" \
    && -r "$release_current_root/deploy/compose.yaml" ]] || fail 'release-directory-unavailable'
}

release_compose() {
  local options=(docker compose --env-file "$release_current_root/release.env" \
    --file "$release_current_root/deploy/compose.yaml")
  if [[ -n "${CLAUDIAN_DEPLOY_COMPOSE_PROJECT:-}" ]]; then
    options+=(--project-name "$CLAUDIAN_DEPLOY_COMPOSE_PROJECT")
  fi
  "${options[@]}" "$@"
}

release_hash() {
  local digest rest
  read -r digest rest < <(sha256sum "$1")
  is_operation_identity "$digest" || return 1
  printf '%s\n' "$digest"
}

release_validate_archive() {
  local entry
  tar -tzf "$release_candidate_directory/claudian-cloud-server.tar.gz" \
    > "$release_candidate_directory/archive-entries" || fail 'release-archive-invalid'
  while IFS= read -r entry; do
    [[ "$entry" =~ ^claudian-cloud-server(/[A-Za-z0-9._-]+)*/?$ \
      && "/$entry/" != *'/../'* && "/$entry/" != *'/./'* ]] || fail 'release-archive-invalid'
  done < "$release_candidate_directory/archive-entries"
  # Reject links and special files before privileged extraction.
  tar -tvzf "$release_candidate_directory/claudian-cloud-server.tar.gz" \
    | awk 'substr($0, 1, 1) != "-" && substr($0, 1, 1) != "d" { exit 1 }' \
    || fail 'release-archive-invalid'
  tar --no-same-owner -xzf "$release_candidate_directory/claudian-cloud-server.tar.gz" \
    -C "$release_candidate_directory" || fail 'release-archive-invalid'
  release_bundle="$release_candidate_directory/claudian-cloud-server"
  [[ -f "$release_bundle/deploy/deploy.sh" \
    && -f "$release_bundle/deploy/release-update.sh" \
    && -f "$release_bundle/deploy/compose.yaml" ]] || fail 'release-update-unsupported'
}

release_model_project() {
  docker run --rm --interactive --network none --read-only --cap-drop ALL \
    --security-opt no-new-privileges:true --entrypoint node "$candidate_image" \
    --input-type=module -e '
      try {
        let input = "";
        for await (const chunk of process.stdin) input += chunk;
        const name = JSON.parse(input).name;
        if (typeof name !== "string" || !/^[a-z0-9][a-z0-9_-]{0,62}$/.test(name)) process.exit(1);
        process.stdout.write(name);
      } catch { process.exit(1); }
    '
}

release_prepare_candidate() {
  [[ "$release_tag" == 'latest' \
    || "$release_tag" =~ ^v[0-9]+\.[0-9]+\.[0-9]+(-[A-Za-z0-9.-]+)?$ ]] || fail 'release-tag-invalid'
  operation_id="$(generate_operation_identity)"
  mkdir -p "$release_cache"
  chmod 0700 "$release_cache"
  release_candidate_directory="$release_cache/$operation_id"
  mkdir -m 0700 "$release_candidate_directory"
  local base='https://github.com/YishenTu/claudian-cloud-server/releases'
  if [[ "$release_tag" == 'latest' ]]; then
    base="$base/latest/download"
  else
    base="$base/download/$release_tag"
  fi
  local asset expected_checksum='' checksum_name='' extra=''
  for asset in claudian-cloud-server.tar.gz claudian-cloud-server.tar.gz.sha256; do
    curl --fail --location --silent --show-error --proto '=https' --proto-redir '=https' \
      --output "$release_candidate_directory/$asset" "$base/$asset" || fail 'release-download-failed'
  done
  IFS=' ' read -r expected_checksum checksum_name extra \
    < "$release_candidate_directory/claudian-cloud-server.tar.gz.sha256" || fail 'release-checksum-invalid'
  [[ "$checksum_name" == 'claudian-cloud-server.tar.gz' && -z "$extra" \
    && "$(wc -l < "$release_candidate_directory/claudian-cloud-server.tar.gz.sha256")" -eq 1 ]] || \
    fail 'release-checksum-invalid'
  is_operation_identity "$expected_checksum" || fail 'release-checksum-invalid'
  [[ "$(release_hash "$release_candidate_directory/claudian-cloud-server.tar.gz")" == "$expected_checksum" ]] || \
    fail 'release-checksum-mismatch'
  release_validate_archive
  revision="$(cat "$release_bundle/revision.txt")"
  is_git_revision "$revision" || fail 'release-revision-invalid'
  image_tag="$(sed -n 's/^CLAUDIAN_CLOUD_IMAGE=//p' "$release_bundle/release.env")"
  [[ "$image_tag" =~ ^ghcr\.io/[a-z0-9._/-]+@sha256:[a-f0-9]{64}$ ]] || fail 'release-image-invalid'
  printf 'deployment.pulling revision=%s\n' "$revision"
  docker pull "$image_tag" || fail 'release-image-pull-failed'
  candidate_image="$(docker image inspect --format '{{.Id}}' "$image_tag")" || fail 'candidate-image-unavailable'
  is_image_identity "$candidate_image" || fail 'candidate-image-identity-invalid'

  # Preserve operator settings without evaluating the environment file as shell code.
  sed '/^CLAUDIAN_CLOUD_IMAGE=/d' "$release_current_root/release.env" > "$release_bundle/release.env"
  printf '\nCLAUDIAN_CLOUD_IMAGE=%s\n' "$image_tag" >> "$release_bundle/release.env"
  chmod 0600 "$release_bundle/release.env"
  release_compose --profile '*' config --format json \
    > "$release_candidate_directory/previous-compose.json" || fail 'previous-configuration-invalid'
  compose_project="$(release_model_project < "$release_candidate_directory/previous-compose.json")" || \
    fail 'release-project-invalid'
  printf '%s\n' "$compose_project" > "$release_candidate_directory/project-name"
  # These private snapshots include resolved environment values and must never be logged.
  CLAUDIAN_CLOUD_IMAGE="$candidate_image" \
  CLAUDIAN_CLOUD_MAINTENANCE_OPERATION_ID="$operation_id" \
  CLAUDIAN_CLOUD_RESTORE_RECOVERY_REQUIRED=true \
  CLAUDIAN_CLOUD_PROJECT_RECOVERY_REQUIRED=true \
    docker compose --env-file "$release_bundle/release.env" \
      --file "$release_bundle/deploy/compose.yaml" --project-name "$compose_project" \
      --profile '*' config --format json > "$release_candidate_directory/candidate-compose.json" \
      || fail 'candidate-configuration-invalid'
}

release_compose_for() {
  local selected_image="$1" model='previous-compose.json'
  shift
  if [[ "$selected_image" == "$candidate_image" || "$selected_image" == "$image_tag" ]]; then
    model='candidate-compose.json'
  fi
  CLAUDIAN_CLOUD_IMAGE="$selected_image" \
    docker compose --env-file /dev/null --file "$release_candidate_directory/$model" \
      --project-name "$compose_project" "$@"
}

release_freeze_previous() {
  CLAUDIAN_CLOUD_IMAGE="$1" release_compose --profile '*' config --format json \
    > "$release_candidate_directory/previous-compose.json" || fail 'previous-configuration-invalid'
}

release_record_manifest() {
  (
    cd "$release_candidate_directory"
    find claudian-cloud-server -type f -print0 | LC_ALL=C sort -z | xargs -0 sha256sum
    sha256sum candidate-compose.json previous-compose.json project-name
  ) > "$release_candidate_directory/manifest.sha256" || fail 'release-manifest-unavailable'
  release_manifest="$(release_hash "$release_candidate_directory/manifest.sha256")" || \
    fail 'release-manifest-unavailable'
  sync >/dev/null 2>&1
}

release_resume_candidate() {
  release_candidate_directory="$release_cache/$operation_id"
  release_bundle="$release_candidate_directory/claudian-cloud-server"
  [[ -d "$release_candidate_directory" && ! -L "$release_candidate_directory" \
    && -f "$release_candidate_directory/manifest.sha256" \
    && ! -L "$release_candidate_directory/manifest.sha256" ]] || fail 'release-candidate-unavailable'
  [[ "$(release_hash "$release_candidate_directory/manifest.sha256")" == "$release_manifest" ]] || \
    fail 'release-candidate-changed'
  (cd "$release_candidate_directory" && sha256sum --check --status manifest.sha256) || \
    fail 'release-candidate-changed'
  [[ "$(cat "$release_bundle/revision.txt")" == "$revision" ]] || fail 'release-candidate-changed'
  image_tag="$(sed -n 's/^CLAUDIAN_CLOUD_IMAGE=//p' "$release_bundle/release.env")"
  [[ "$image_tag" =~ ^ghcr\.io/[a-z0-9._/-]+@sha256:[a-f0-9]{64}$ ]] || fail 'release-candidate-changed'
  compose_project="$(cat "$release_candidate_directory/project-name")"
  [[ "$compose_project" =~ ^[a-z0-9][a-z0-9_-]{0,62}$ ]] || fail 'release-candidate-changed'
  printf 'deployment.resuming revision=%s\n' "$revision"
}

release_activate() {
  local temporary_current
  temporary_current="$(mktemp "${release_current_file}.tmp.XXXXXX")" || return 1
  if ! printf 'release-current-v1 %s\n' "$operation_id" > "$temporary_current" \
      || ! sync_forward_state "$temporary_current" \
      || ! mv -f "$temporary_current" "$release_current_file"; then
    rm -f "$temporary_current"
    return 1
  fi
  sync >/dev/null 2>&1
}

release_cleanup_snapshots() {
  rm -f "$release_candidate_directory/candidate-compose.json" \
    "$release_candidate_directory/previous-compose.json" "$release_candidate_directory/manifest.sha256"
}
