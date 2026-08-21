ALTER TABLE claudian_cloud.projects
  ADD COLUMN project_name varchar(200) NOT NULL,
  ADD COLUMN manager_set_generation bigint NOT NULL,
  ADD COLUMN expected_main_oid varchar(64) NOT NULL,
  ADD COLUMN service_state text NOT NULL,
  ADD COLUMN activated_at timestamptz NOT NULL,
  ADD CONSTRAINT projects_project_name_present
    CHECK (project_name <> ''),
  ADD CONSTRAINT projects_manager_set_generation
    CHECK (manager_set_generation BETWEEN 0 AND 9007199254740991),
  ADD CONSTRAINT projects_expected_main_oid
    CHECK (expected_main_oid ~ '^[0-9a-f]{40}([0-9a-f]{24})?$'),
  ADD CONSTRAINT projects_service_state
    CHECK (service_state IN ('active', 'recovery-required'));

ALTER TABLE claudian_cloud.project_memberships
  ADD COLUMN display_name varchar(200) NOT NULL,
  ADD CONSTRAINT project_memberships_display_name_present
    CHECK (display_name <> '');

CREATE TABLE claudian_cloud.development_bootstrap_attempts (
  project_id varchar(64) NOT NULL,
  attempt_id varchar(128) NOT NULL,
  source_host_member_id varchar(64) NOT NULL,
  manifest_sha256 varchar(64) NOT NULL,
  manifest_json text NOT NULL,
  state text NOT NULL,
  bundle_state text NOT NULL,
  created_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  PRIMARY KEY (project_id, attempt_id),
  CONSTRAINT development_bootstrap_attempts_project_id
    CHECK (project_id ~ '^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$'),
  CONSTRAINT development_bootstrap_attempts_attempt_id
    CHECK (attempt_id ~ '^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$'),
  CONSTRAINT development_bootstrap_attempts_source_host
    CHECK (source_host_member_id ~ '^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$'),
  CONSTRAINT development_bootstrap_attempts_manifest_sha256
    CHECK (manifest_sha256 ~ '^[0-9a-f]{64}$'),
  CONSTRAINT development_bootstrap_attempts_manifest_size
    CHECK (octet_length(manifest_json) BETWEEN 2 AND 65536),
  CONSTRAINT development_bootstrap_attempts_state
    CHECK (state IN (
      'collecting',
      'validating',
      'ready',
      'activating',
      'rejected',
      'cancelled',
      'recovery-required',
      'activated'
    )),
  CONSTRAINT development_bootstrap_attempts_bundle_state
    CHECK (bundle_state IN ('missing', 'uploaded', 'validated')),
  CONSTRAINT development_bootstrap_attempts_timestamps
    CHECK (expires_at > created_at AND updated_at >= created_at)
);

CREATE UNIQUE INDEX development_bootstrap_one_nonterminal_per_project
  ON claudian_cloud.development_bootstrap_attempts (project_id)
  WHERE state IN (
    'collecting',
    'validating',
    'ready',
    'activating',
    'recovery-required'
  );

CREATE INDEX development_bootstrap_attempts_by_expiry
  ON claudian_cloud.development_bootstrap_attempts (
    expires_at,
    project_id,
    attempt_id
  );

CREATE TABLE claudian_cloud.development_bootstrap_attempt_routes (
  attempt_id varchar(128) PRIMARY KEY,
  project_id varchar(64) NOT NULL,
  CONSTRAINT development_bootstrap_attempt_routes_attempt
    FOREIGN KEY (project_id, attempt_id)
    REFERENCES claudian_cloud.development_bootstrap_attempts (
      project_id,
      attempt_id
    )
    ON DELETE CASCADE
);

CREATE TABLE claudian_cloud.development_bootstrap_expiry_candidates (
  project_id varchar(64) NOT NULL,
  attempt_id varchar(128) NOT NULL,
  expires_at timestamptz NOT NULL,
  PRIMARY KEY (project_id, attempt_id),
  CONSTRAINT development_bootstrap_expiry_candidates_attempt
    FOREIGN KEY (project_id, attempt_id)
    REFERENCES claudian_cloud.development_bootstrap_attempts (
      project_id,
      attempt_id
    )
    ON DELETE CASCADE
);

CREATE INDEX development_bootstrap_expiry_candidates_page
  ON claudian_cloud.development_bootstrap_expiry_candidates (
    expires_at,
    project_id,
    attempt_id
  );

CREATE FUNCTION claudian_cloud.find_development_bootstrap_project(
  requested_attempt_id varchar
)
RETURNS varchar
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
  SELECT route.project_id
    FROM claudian_cloud.development_bootstrap_attempt_routes AS route
   WHERE route.attempt_id = requested_attempt_id
$$;

CREATE FUNCTION claudian_cloud.put_development_bootstrap_attempt_route(
  requested_attempt_id varchar,
  requested_project_id varchar
)
RETURNS boolean
LANGUAGE sql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
  WITH inserted AS (
    INSERT INTO claudian_cloud.development_bootstrap_attempt_routes (
      attempt_id,
      project_id
    ) VALUES (
      requested_attempt_id,
      requested_project_id
    )
    ON CONFLICT (attempt_id) DO NOTHING
    RETURNING project_id
  )
  SELECT COALESCE(
    (SELECT route.project_id = requested_project_id
       FROM inserted AS route),
    (SELECT route.project_id = requested_project_id
       FROM claudian_cloud.development_bootstrap_attempt_routes AS route
      WHERE route.attempt_id = requested_attempt_id),
    false
  )
$$;

CREATE TABLE claudian_cloud.development_bootstrap_reports (
  project_id varchar(64) NOT NULL,
  attempt_id varchar(128) NOT NULL,
  reporter_member_id varchar(64) NOT NULL,
  report_sha256 varchar(64) NOT NULL,
  report_json text NOT NULL,
  captured_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL,
  PRIMARY KEY (project_id, attempt_id, reporter_member_id),
  CONSTRAINT development_bootstrap_reports_attempt
    FOREIGN KEY (project_id, attempt_id)
    REFERENCES claudian_cloud.development_bootstrap_attempts (
      project_id,
      attempt_id
    )
    ON DELETE CASCADE,
  CONSTRAINT development_bootstrap_reports_reporter
    CHECK (reporter_member_id ~ '^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$'),
  CONSTRAINT development_bootstrap_reports_sha256
    CHECK (report_sha256 ~ '^[0-9a-f]{64}$'),
  CONSTRAINT development_bootstrap_reports_size
    CHECK (octet_length(report_json) BETWEEN 2 AND 65536)
);

CREATE TABLE claudian_cloud.development_bootstrap_uploads (
  project_id varchar(64) NOT NULL,
  attempt_id varchar(128) NOT NULL,
  byte_count bigint NOT NULL,
  sha256 varchar(64) NOT NULL,
  staging_artifact_key varchar(128) NOT NULL,
  validation_marker_sha256 varchar(64) NOT NULL,
  state text NOT NULL,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  PRIMARY KEY (project_id, attempt_id),
  CONSTRAINT development_bootstrap_uploads_attempt
    FOREIGN KEY (project_id, attempt_id)
    REFERENCES claudian_cloud.development_bootstrap_attempts (
      project_id,
      attempt_id
    )
    ON DELETE CASCADE,
  CONSTRAINT development_bootstrap_uploads_byte_count
    CHECK (byte_count BETWEEN 1 AND 1073741824),
  CONSTRAINT development_bootstrap_uploads_sha256
    CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  CONSTRAINT development_bootstrap_uploads_staging_key
    CHECK (staging_artifact_key ~ '^[a-z0-9][a-z0-9_-]{0,127}$'),
  CONSTRAINT development_bootstrap_uploads_validation_marker_sha256
    CHECK (validation_marker_sha256 ~ '^[0-9a-f]{64}$'),
  CONSTRAINT development_bootstrap_uploads_state
    CHECK (state IN ('uploaded', 'validated')),
  CONSTRAINT development_bootstrap_uploads_timestamps
    CHECK (updated_at >= created_at)
);

CREATE TABLE claudian_cloud.development_bootstrap_settlements (
  project_id varchar(64) NOT NULL,
  attempt_id varchar(128) NOT NULL,
  operation_id varchar(128) NOT NULL,
  kind text NOT NULL,
  activation_phase text,
  cancellation_phase text,
  journal_json text NOT NULL,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  PRIMARY KEY (project_id, attempt_id),
  CONSTRAINT development_bootstrap_settlements_attempt
    FOREIGN KEY (project_id, attempt_id)
    REFERENCES claudian_cloud.development_bootstrap_attempts (
      project_id,
      attempt_id
    ),
  CONSTRAINT development_bootstrap_settlements_operation_id
    CHECK (operation_id ~ '^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$'),
  CONSTRAINT development_bootstrap_settlements_kind
    CHECK (kind IN ('activation', 'cancellation')),
  CONSTRAINT development_bootstrap_settlements_activation_phase
    CHECK (
      activation_phase IS NULL
      OR activation_phase IN (
        'publish-intent',
        'repository-published',
        'activated',
        'completed'
      )
    ),
  CONSTRAINT development_bootstrap_settlements_cancellation_phase
    CHECK (
      cancellation_phase IS NULL
      OR cancellation_phase IN (
        'cancel-intent',
        'cancelled',
        'recovery-required'
      )
    ),
  CONSTRAINT development_bootstrap_settlements_exact_phase
    CHECK (
      (
        kind = 'activation'
        AND activation_phase IS NOT NULL
        AND cancellation_phase IS NULL
      )
      OR (
        kind = 'cancellation'
        AND activation_phase IS NULL
        AND cancellation_phase IS NOT NULL
      )
    ),
  CONSTRAINT development_bootstrap_settlements_journal_size
    CHECK (octet_length(journal_json) BETWEEN 2 AND 524288),
  CONSTRAINT development_bootstrap_settlements_timestamps
    CHECK (updated_at >= created_at)
);

CREATE UNIQUE INDEX development_bootstrap_one_nonterminal_settlement_per_project
  ON claudian_cloud.development_bootstrap_settlements (project_id)
  WHERE (
    (kind = 'activation' AND activation_phase <> 'completed')
    OR (kind = 'cancellation' AND cancellation_phase = 'cancel-intent')
  );

CREATE TABLE claudian_cloud.development_actor_mappings (
  project_id varchar(64) NOT NULL,
  actor_id varchar(64) NOT NULL,
  member_id varchar(64) NOT NULL,
  created_at timestamptz NOT NULL,
  PRIMARY KEY (project_id, actor_id),
  CONSTRAINT development_actor_mappings_member_unique
    UNIQUE (project_id, member_id),
  CONSTRAINT development_actor_mappings_membership
    FOREIGN KEY (project_id, member_id)
    REFERENCES claudian_cloud.project_memberships (project_id, member_id),
  CONSTRAINT development_actor_mappings_actor_member
    CHECK (actor_id = member_id)
);

CREATE TABLE claudian_cloud.recovery_candidates (
  kind text NOT NULL,
  project_id varchar(64) NOT NULL,
  operation_id varchar(128) NOT NULL,
  scheduled_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL,
  PRIMARY KEY (kind, project_id),
  CONSTRAINT recovery_candidates_kind
    CHECK (kind IN ('activation', 'accept')),
  CONSTRAINT recovery_candidates_project_id
    CHECK (project_id ~ '^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$'),
  CONSTRAINT recovery_candidates_operation_id
    CHECK (operation_id ~ '^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$'),
  CONSTRAINT recovery_candidates_schedule
    CHECK (scheduled_at >= created_at)
);

CREATE INDEX recovery_candidates_schedule_page
  ON claudian_cloud.recovery_candidates (
    scheduled_at,
    kind,
    project_id,
    operation_id
  );

CREATE TABLE claudian_cloud.active_repository_placement_catalog (
  project_id varchar(64) PRIMARY KEY,
  storage_node_id varchar(64) NOT NULL,
  repository_storage_key varchar(128) NOT NULL,
  generation bigint NOT NULL,
  CONSTRAINT active_repository_placement_catalog_project
    FOREIGN KEY (project_id)
    REFERENCES claudian_cloud.projects (project_id),
  CONSTRAINT active_repository_placement_catalog_project_id
    CHECK (project_id ~ '^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$'),
  CONSTRAINT active_repository_placement_catalog_storage_node
    CHECK (storage_node_id ~ '^[a-z0-9]([a-z0-9._-]{0,62}[a-z0-9])?$'),
  CONSTRAINT active_repository_placement_catalog_storage_key
    CHECK (repository_storage_key ~ '^[a-z0-9][a-z0-9_-]{0,127}$'),
  CONSTRAINT active_repository_placement_catalog_generation
    CHECK (generation BETWEEN 1 AND 9007199254740991)
);

ALTER TABLE claudian_cloud.development_bootstrap_attempts
  ENABLE ROW LEVEL SECURITY;
ALTER TABLE claudian_cloud.development_bootstrap_attempts
  FORCE ROW LEVEL SECURITY;
ALTER TABLE claudian_cloud.development_bootstrap_reports
  ENABLE ROW LEVEL SECURITY;
ALTER TABLE claudian_cloud.development_bootstrap_reports
  FORCE ROW LEVEL SECURITY;
ALTER TABLE claudian_cloud.development_bootstrap_uploads
  ENABLE ROW LEVEL SECURITY;
ALTER TABLE claudian_cloud.development_bootstrap_uploads
  FORCE ROW LEVEL SECURITY;
ALTER TABLE claudian_cloud.development_bootstrap_settlements
  ENABLE ROW LEVEL SECURITY;
ALTER TABLE claudian_cloud.development_bootstrap_settlements
  FORCE ROW LEVEL SECURITY;
ALTER TABLE claudian_cloud.development_actor_mappings
  ENABLE ROW LEVEL SECURITY;
ALTER TABLE claudian_cloud.development_actor_mappings
  FORCE ROW LEVEL SECURITY;

CREATE POLICY development_bootstrap_attempts_project_scope
  ON claudian_cloud.development_bootstrap_attempts
  USING (
    project_id = nullif(current_setting('claudian_cloud.project_id', true), '')
  )
  WITH CHECK (
    project_id = nullif(current_setting('claudian_cloud.project_id', true), '')
  );

CREATE POLICY development_bootstrap_reports_project_scope
  ON claudian_cloud.development_bootstrap_reports
  USING (
    project_id = nullif(current_setting('claudian_cloud.project_id', true), '')
  )
  WITH CHECK (
    project_id = nullif(current_setting('claudian_cloud.project_id', true), '')
  );

CREATE POLICY development_bootstrap_uploads_project_scope
  ON claudian_cloud.development_bootstrap_uploads
  USING (
    project_id = nullif(current_setting('claudian_cloud.project_id', true), '')
  )
  WITH CHECK (
    project_id = nullif(current_setting('claudian_cloud.project_id', true), '')
  );

CREATE POLICY development_bootstrap_settlements_project_scope
  ON claudian_cloud.development_bootstrap_settlements
  USING (
    project_id = nullif(current_setting('claudian_cloud.project_id', true), '')
  )
  WITH CHECK (
    project_id = nullif(current_setting('claudian_cloud.project_id', true), '')
  );

CREATE POLICY development_actor_mappings_project_scope
  ON claudian_cloud.development_actor_mappings
  USING (
    project_id = nullif(current_setting('claudian_cloud.project_id', true), '')
  )
  WITH CHECK (
    project_id = nullif(current_setting('claudian_cloud.project_id', true), '')
  );

REVOKE ALL ON
  claudian_cloud.development_bootstrap_attempts,
  claudian_cloud.development_bootstrap_expiry_candidates,
  claudian_cloud.development_bootstrap_attempt_routes,
  claudian_cloud.development_bootstrap_reports,
  claudian_cloud.development_bootstrap_uploads,
  claudian_cloud.development_bootstrap_settlements,
  claudian_cloud.development_actor_mappings,
  claudian_cloud.active_repository_placement_catalog,
  claudian_cloud.recovery_candidates
FROM PUBLIC;

GRANT SELECT, INSERT, UPDATE, DELETE ON
  claudian_cloud.development_bootstrap_attempts,
  claudian_cloud.development_bootstrap_expiry_candidates,
  claudian_cloud.development_bootstrap_reports,
  claudian_cloud.development_bootstrap_uploads,
  claudian_cloud.development_bootstrap_settlements,
  claudian_cloud.development_actor_mappings,
  claudian_cloud.active_repository_placement_catalog,
  claudian_cloud.recovery_candidates
TO claudian_cloud_runtime;

REVOKE ALL ON FUNCTION
  claudian_cloud.find_development_bootstrap_project(varchar)
FROM PUBLIC;

REVOKE ALL ON FUNCTION
  claudian_cloud.put_development_bootstrap_attempt_route(varchar, varchar)
FROM PUBLIC;

GRANT EXECUTE ON FUNCTION
  claudian_cloud.find_development_bootstrap_project(varchar),
  claudian_cloud.put_development_bootstrap_attempt_route(varchar, varchar)
TO claudian_cloud_runtime;
