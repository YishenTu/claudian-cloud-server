#!/usr/bin/env bash

set -Eeuo pipefail
umask 077

fail() {
  printf 'bootstrap.error: %s\n' "$1" >&2
  exit 1
}

for field in \
  PGHOST \
  PGPORT \
  PGUSER \
  PGPASSWORD \
  PGDATABASE \
  CLAUDIAN_CLOUD_POSTGRES_MIGRATION_PASSWORD \
  CLAUDIAN_CLOUD_POSTGRES_RUNTIME_PASSWORD; do
  [[ -n "${!field:-}" ]] || fail 'configuration-invalid'
done

[[ "$PGHOST" == '127.0.0.1' ]] || fail 'configuration-invalid'
[[ "$PGPORT" =~ ^[1-9][0-9]{0,4}$ ]] || fail 'configuration-invalid'
(( PGPORT <= 65535 )) || fail 'configuration-invalid'
[[ "$PGUSER" == 'claudian_cloud_bootstrap' ]] || fail 'configuration-invalid'
[[ "$PGDATABASE" == 'postgres' ]] || fail 'configuration-invalid'
[[ "$PGPASSWORD" =~ ^[A-Za-z0-9_-]{16,128}$ ]] || fail 'configuration-invalid'
[[ "$CLAUDIAN_CLOUD_POSTGRES_MIGRATION_PASSWORD" =~ ^[A-Za-z0-9_-]{16,128}$ ]] || \
  fail 'configuration-invalid'
[[ "$CLAUDIAN_CLOUD_POSTGRES_RUNTIME_PASSWORD" =~ ^[A-Za-z0-9_-]{16,128}$ ]] || \
  fail 'configuration-invalid'

migration_password="${CLAUDIAN_CLOUD_POSTGRES_MIGRATION_PASSWORD//\'/\'\'}"
runtime_password="${CLAUDIAN_CLOUD_POSTGRES_RUNTIME_PASSWORD//\'/\'\'}"
sql_file="$(mktemp /tmp/claudian-cloud-bootstrap.XXXXXX.sql)"
temporary_marker=''
cleanup() {
  rm -f "$sql_file"
  if [[ -n "$temporary_marker" ]]; then rm -f "$temporary_marker"; fi
}
trap cleanup EXIT

cat > "$sql_file" <<SQL
DO \$claudian\$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_roles WHERE rolname = 'claudian_cloud_migration'
  ) THEN
    CREATE ROLE claudian_cloud_migration;
  END IF;
  ALTER ROLE claudian_cloud_migration
    LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS
    PASSWORD '$migration_password';

  IF NOT EXISTS (
    SELECT 1 FROM pg_roles WHERE rolname = 'claudian_cloud_runtime'
  ) THEN
    CREATE ROLE claudian_cloud_runtime;
  END IF;
  ALTER ROLE claudian_cloud_runtime
    LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS
    PASSWORD '$runtime_password';
END
\$claudian\$;
SQL

psql --no-psqlrc --set ON_ERROR_STOP=on --file "$sql_file" \
  >/dev/null 2>&1 || \
  fail 'role-provisioning-failed'

authority_marker='/var/lib/claudian-cloud/.authority-volume-id'
pending_authority_marker='/var/lib/claudian-cloud/.authority-volume-id.pending'
authority_id=''
if [[ -e "$authority_marker" ]]; then
  [[ -f "$authority_marker" && ! -L "$authority_marker" ]] || \
    fail 'authority-marker-invalid'
  [[ "$(stat --format='%u:%g:%a' "$authority_marker")" == '10001:10001:600' ]] || \
    fail 'authority-marker-invalid'
  authority_id="$(<"$authority_marker")"
  [[ "$authority_id" =~ ^[0-9a-f]{32}$ ]] || fail 'authority-marker-invalid'
fi
pending_authority_id=''
if [[ -e "$pending_authority_marker" ]]; then
  [[ -f "$pending_authority_marker" && ! -L "$pending_authority_marker" ]] || \
    fail 'authority-marker-invalid'
  [[ "$(stat --format='%u:%g:%a' "$pending_authority_marker")" == '10001:10001:600' ]] || \
    fail 'authority-marker-invalid'
  pending_authority_id="$(<"$pending_authority_marker")"
  [[ "$pending_authority_id" =~ ^[0-9a-f]{32}$ ]] || \
    fail 'authority-marker-invalid'
fi
[[ -z "$authority_id" || -z "$pending_authority_id" ]] || \
  fail 'authority-marker-invalid'

persist_database_authority_id() {
  local id="$1"
  cat > "$sql_file" <<SQL
ALTER DATABASE claudian_cloud
  SET claudian_cloud.authority_volume_id TO '$id';
SQL
  psql --no-psqlrc --set ON_ERROR_STOP=on --file "$sql_file" \
    >/dev/null 2>&1 || \
    fail 'authority-volume-pair-failed'
}

database_owner="$(
  psql \
    --no-psqlrc \
    --set ON_ERROR_STOP=on \
    --tuples-only \
    --no-align \
    --command="SELECT pg_get_userbyid(datdba) FROM pg_database WHERE datname = 'claudian_cloud'" \
    2>/dev/null
)" || fail 'database-inspection-failed'

if [[ -z "$database_owner" ]]; then
  [[ -z "$authority_id" ]] || fail 'authority-volume-pair-mismatch'
  install -d -m 0700 -o 10001 -g 10001 /var/lib/claudian-cloud
  if [[ -z "$pending_authority_id" ]]; then
    temporary_marker="$(mktemp /var/lib/claudian-cloud/.authority-volume-id.XXXXXX)"
    tr -d '-' < /proc/sys/kernel/random/uuid > "$temporary_marker"
    pending_authority_id="$(<"$temporary_marker")"
    [[ "$pending_authority_id" =~ ^[0-9a-f]{32}$ ]] || \
      fail 'authority-marker-invalid'
    chown 10001:10001 "$temporary_marker"
    chmod 0600 "$temporary_marker"
    mv "$temporary_marker" "$pending_authority_marker"
    temporary_marker=''
  fi
  psql \
    --no-psqlrc \
    --set ON_ERROR_STOP=on \
    --command='CREATE DATABASE claudian_cloud OWNER claudian_cloud_migration' \
    >/dev/null 2>&1 || fail 'database-provisioning-failed'
  persist_database_authority_id "$pending_authority_id"
  mv "$pending_authority_marker" "$authority_marker"
  authority_id="$pending_authority_id"
  pending_authority_id=''
elif [[ "$database_owner" != 'claudian_cloud_migration' ]]; then
  fail 'database-owner-mismatch'
else
  database_authority_id="$(
    PGDATABASE=claudian_cloud psql \
      --no-psqlrc \
      --set ON_ERROR_STOP=on \
      --tuples-only \
      --no-align \
      --command="SELECT current_setting('claudian_cloud.authority_volume_id', true)" \
      2>/dev/null
  )" || fail 'authority-volume-pair-inspection-failed'
  if [[ -n "$authority_id" ]]; then
    [[ -z "$pending_authority_id" && "$database_authority_id" == "$authority_id" ]] || \
      fail 'authority-volume-pair-mismatch'
  elif [[ -n "$pending_authority_id" ]]; then
    if [[ -z "$database_authority_id" ]]; then
      persist_database_authority_id "$pending_authority_id"
      database_authority_id="$pending_authority_id"
    fi
    [[ "$database_authority_id" == "$pending_authority_id" ]] || \
      fail 'authority-volume-pair-mismatch'
    mv "$pending_authority_marker" "$authority_marker"
    authority_id="$pending_authority_id"
    pending_authority_id=''
  else
    fail 'authority-volume-pair-mismatch'
  fi
fi

psql \
  --no-psqlrc \
  --set ON_ERROR_STOP=on \
  --command='REVOKE ALL ON DATABASE claudian_cloud FROM PUBLIC' \
  --command='GRANT CONNECT ON DATABASE claudian_cloud TO claudian_cloud_migration, claudian_cloud_runtime' \
  >/dev/null 2>&1 || fail 'database-grant-failed'

install -d -m 0700 -o 10001 -g 10001 \
  /var/lib/claudian-cloud/repositories \
  /var/lib/claudian-cloud/staging
