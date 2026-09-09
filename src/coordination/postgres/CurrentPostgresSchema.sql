-- Current coordination schema. The initializer owns the schema namespace and metadata.
-- All domain objects are created by claudian_cloud_migration in one transaction.

-- Project state, collaboration records, and lifecycle persistence.

CREATE TABLE claudian_cloud.projects (
  project_id varchar(64) PRIMARY KEY,
  created_at timestamptz NOT NULL,
  project_name varchar(200) NOT NULL,
  manager_set_generation bigint NOT NULL,
  expected_main_oid varchar(64) NOT NULL,
  service_state text NOT NULL,
  activated_at timestamptz NOT NULL,
  authority_generation bigint NOT NULL DEFAULT 1,
  authority_state_revision bigint NOT NULL DEFAULT 1,
  CONSTRAINT projects_project_id_present
    CHECK (project_id <> ''),
  CONSTRAINT projects_project_name_present
    CHECK (project_name <> ''),
  CONSTRAINT projects_manager_set_generation
    CHECK (manager_set_generation BETWEEN 0 AND 9007199254740991),
  CONSTRAINT projects_expected_main_oid
    CHECK (expected_main_oid ~ '^[0-9a-f]{40}([0-9a-f]{24})?$'),
  CONSTRAINT projects_authority_generation
    CHECK (authority_generation BETWEEN 1 AND 9007199254740991),
  CONSTRAINT projects_authority_state_revision
    CHECK (authority_state_revision BETWEEN 1 AND 9007199254740991),
  CONSTRAINT projects_service_state
    CHECK (
      service_state IN (
        'active',
        'deleted',
        'deleting',
        'maintenance',
        'read-only-transition',
        'recovery-required'
      )
    )
);

CREATE TABLE claudian_cloud.project_memberships (
  project_id varchar(64) NOT NULL,
  member_id varchar(64) NOT NULL,
  role text NOT NULL,
  status text NOT NULL,
  revision bigint NOT NULL,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  display_name varchar(200) NOT NULL,
  activated_at timestamptz,
  revoked_at timestamptz,
  left_at timestamptz,
  PRIMARY KEY (project_id, member_id),
  CONSTRAINT project_memberships_project
    FOREIGN KEY (project_id)
    REFERENCES claudian_cloud.projects(project_id),
  CONSTRAINT project_memberships_member_id_present
    CHECK (member_id <> ''),
  CONSTRAINT project_memberships_role
    CHECK (role IN ('manager', 'member')),
  CONSTRAINT project_memberships_status
    CHECK (status IN ('pending', 'active', 'revoked', 'left')),
  CONSTRAINT project_memberships_revision
    CHECK (revision > 0),
  CONSTRAINT project_memberships_timestamps
    CHECK (updated_at >= created_at),
  CONSTRAINT project_memberships_display_name_present
    CHECK (display_name <> ''),
  CONSTRAINT project_memberships_lifecycle_timestamps
    CHECK (
      (activated_at IS NULL OR activated_at >= created_at)
      AND (revoked_at IS NULL OR revoked_at >= created_at)
      AND (left_at IS NULL OR left_at >= created_at)
      AND (status = 'left') = (left_at IS NOT NULL)
      AND (status = 'revoked') = (revoked_at IS NOT NULL)
      AND (
        activated_at IS NULL
        OR revoked_at IS NULL
        OR revoked_at >= activated_at
      )
      AND (
        activated_at IS NULL
        OR left_at IS NULL
        OR left_at >= activated_at
      )
    )
);

CREATE TABLE claudian_cloud.repository_placements (
  project_id varchar(64) PRIMARY KEY,
  storage_node_id varchar(64) NOT NULL,
  repository_storage_key varchar(128) NOT NULL,
  generation bigint NOT NULL,
  active boolean NOT NULL,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  CONSTRAINT repository_placements_project
    FOREIGN KEY (project_id)
    REFERENCES claudian_cloud.projects(project_id),
  CONSTRAINT repository_placements_storage_node_id_format
    CHECK (storage_node_id ~ '^[a-z0-9]([a-z0-9._-]{0,62}[a-z0-9])?$'),
  CONSTRAINT repository_placements_storage_key_format
    CHECK (repository_storage_key ~ '^[a-z0-9][a-z0-9_-]{0,127}$'),
  CONSTRAINT repository_placements_generation
    CHECK (generation BETWEEN 1 AND 9007199254740991),
  CONSTRAINT repository_placements_timestamps
    CHECK (updated_at >= created_at)
);

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
  CONSTRAINT recovery_candidates_project_id
    CHECK (project_id ~ '^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$'),
  CONSTRAINT recovery_candidates_operation_id
    CHECK (operation_id ~ '^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$'),
  CONSTRAINT recovery_candidates_schedule
    CHECK (scheduled_at >= created_at),
  CONSTRAINT recovery_candidates_kind
    CHECK (
      kind IN (
        'activation',
        'accept',
        'authority-transfer',
        'backup',
        'create-project',
        'delete',
        'export',
        'join-project',
        'leave',
        'remove-member',
        'retire'
      )
    )
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

CREATE TABLE claudian_cloud.project_event_sequences (
  project_id varchar(64) PRIMARY KEY,
  current_sequence bigint NOT NULL,
  updated_at timestamptz NOT NULL,
  CONSTRAINT project_event_sequences_project
    FOREIGN KEY (project_id)
    REFERENCES claudian_cloud.projects(project_id)
    ON DELETE CASCADE,
  CONSTRAINT project_event_sequences_current_sequence
    CHECK (current_sequence BETWEEN 1 AND 9007199254740991)
);

CREATE TABLE claudian_cloud.project_events (
  project_id varchar(64) NOT NULL,
  sequence bigint NOT NULL,
  kind text NOT NULL,
  payload jsonb NOT NULL,
  occurred_at timestamptz NOT NULL,
  PRIMARY KEY (project_id, sequence),
  CONSTRAINT project_events_project
    FOREIGN KEY (project_id)
    REFERENCES claudian_cloud.projects(project_id)
    ON DELETE CASCADE,
  CONSTRAINT project_events_sequence
    CHECK (sequence BETWEEN 1 AND 9007199254740991),
  CONSTRAINT project_events_payload_object
    CHECK (jsonb_typeof(payload) = 'object'),
  CONSTRAINT project_events_kind
    CHECK (kind IN (
      'membership.updated',
      'request.updated',
      'request.comment-added',
      'ticket.updated',
      'ticket.comment-added',
      'main.updated',
      'authority-transfer.updated',
      'membership.claimed',
      'project.retired'
    ))
);

CREATE TABLE claudian_cloud.change_requests (
  project_id varchar(64) NOT NULL,
  request_id varchar(128) NOT NULL,
  member_id varchar(64) NOT NULL,
  status text NOT NULL,
  first_base_oid varchar(64) NOT NULL,
  latest_head_oid varchar(64) NOT NULL,
  merged_oid varchar(64),
  description text NOT NULL,
  revision bigint NOT NULL,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  PRIMARY KEY (project_id, request_id),
  CONSTRAINT change_requests_project
    FOREIGN KEY (project_id)
    REFERENCES claudian_cloud.projects(project_id)
    ON DELETE CASCADE,
  CONSTRAINT change_requests_member
    FOREIGN KEY (project_id, member_id)
    REFERENCES claudian_cloud.project_memberships(project_id, member_id),
  CONSTRAINT change_requests_request_id_format
    CHECK (request_id ~ '^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$'),
  CONSTRAINT change_requests_status
    CHECK (status IN ('open', 'merged', 'discarded')),
  CONSTRAINT change_requests_first_base_oid_format
    CHECK (first_base_oid ~ '^(?:[0-9a-f]{40}|[0-9a-f]{64})$'),
  CONSTRAINT change_requests_latest_head_oid_format
    CHECK (latest_head_oid ~ '^(?:[0-9a-f]{40}|[0-9a-f]{64})$'),
  CONSTRAINT change_requests_merged_oid_format
    CHECK (
      merged_oid IS NULL
      OR merged_oid ~ '^(?:[0-9a-f]{40}|[0-9a-f]{64})$'
    ),
  CONSTRAINT change_requests_revision
    CHECK (revision BETWEEN 1 AND 9007199254740991),
  CONSTRAINT change_requests_terminal_state
    CHECK (
      (status = 'merged' AND merged_oid IS NOT NULL)
      OR (status IN ('open', 'discarded') AND merged_oid IS NULL)
    ),
  CONSTRAINT change_requests_timestamps
    CHECK (updated_at >= created_at)
);

CREATE TABLE claudian_cloud.request_comments (
  project_id varchar(64) NOT NULL,
  comment_id varchar(128) NOT NULL,
  request_id varchar(128) NOT NULL,
  author_member_id varchar(64) NOT NULL,
  body text NOT NULL,
  created_at timestamptz NOT NULL,
  PRIMARY KEY (project_id, comment_id),
  CONSTRAINT request_comments_project
    FOREIGN KEY (project_id)
    REFERENCES claudian_cloud.projects(project_id)
    ON DELETE CASCADE,
  CONSTRAINT request_comments_request
    FOREIGN KEY (project_id, request_id)
    REFERENCES claudian_cloud.change_requests(project_id, request_id),
  CONSTRAINT request_comments_author
    FOREIGN KEY (project_id, author_member_id)
    REFERENCES claudian_cloud.project_memberships(project_id, member_id),
  CONSTRAINT request_comments_comment_id_format
    CHECK (comment_id ~ '^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$'),
  CONSTRAINT request_comments_body_present
    CHECK (body <> '')
);

CREATE TABLE claudian_cloud.tickets (
  project_id varchar(64) NOT NULL,
  ticket_id varchar(128) NOT NULL,
  ticket_number bigint NOT NULL,
  title varchar(200) NOT NULL,
  body text NOT NULL,
  status text NOT NULL,
  author_member_id varchar(64) NOT NULL,
  revision bigint NOT NULL,
  comment_count bigint NOT NULL,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  closed_at timestamptz,
  closed_by_member_id varchar(64),
  PRIMARY KEY (project_id, ticket_id),
  CONSTRAINT tickets_project
    FOREIGN KEY (project_id)
    REFERENCES claudian_cloud.projects(project_id)
    ON DELETE CASCADE,
  CONSTRAINT tickets_author
    FOREIGN KEY (project_id, author_member_id)
    REFERENCES claudian_cloud.project_memberships(project_id, member_id),
  CONSTRAINT tickets_closed_by_member
    FOREIGN KEY (project_id, closed_by_member_id)
    REFERENCES claudian_cloud.project_memberships(project_id, member_id),
  CONSTRAINT tickets_number_unique
    UNIQUE (project_id, ticket_number),
  CONSTRAINT tickets_ticket_id_format
    CHECK (ticket_id ~ '^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$'),
  CONSTRAINT tickets_ticket_number
    CHECK (ticket_number BETWEEN 1 AND 9007199254740991),
  CONSTRAINT tickets_title_present
    CHECK (title <> ''),
  CONSTRAINT tickets_body_present
    CHECK (body <> ''),
  CONSTRAINT tickets_status
    CHECK (status IN ('open', 'closed')),
  CONSTRAINT tickets_revision
    CHECK (revision BETWEEN 1 AND 9007199254740991),
  CONSTRAINT tickets_comment_count
    CHECK (comment_count BETWEEN 0 AND 500),
  CONSTRAINT tickets_closed_state
    CHECK (
      (status = 'open' AND closed_at IS NULL AND closed_by_member_id IS NULL)
      OR (
        status = 'closed'
        AND closed_at IS NOT NULL
        AND closed_by_member_id IS NOT NULL
      )
    ),
  CONSTRAINT tickets_timestamps
    CHECK (updated_at >= created_at AND (closed_at IS NULL OR closed_at >= created_at))
);

CREATE TABLE claudian_cloud.ticket_comments (
  project_id varchar(64) NOT NULL,
  comment_id varchar(128) NOT NULL,
  ticket_id varchar(128) NOT NULL,
  author_member_id varchar(64) NOT NULL,
  body text NOT NULL,
  created_at timestamptz NOT NULL,
  PRIMARY KEY (project_id, comment_id),
  CONSTRAINT ticket_comments_project
    FOREIGN KEY (project_id)
    REFERENCES claudian_cloud.projects(project_id)
    ON DELETE CASCADE,
  CONSTRAINT ticket_comments_ticket
    FOREIGN KEY (project_id, ticket_id)
    REFERENCES claudian_cloud.tickets(project_id, ticket_id),
  CONSTRAINT ticket_comments_author
    FOREIGN KEY (project_id, author_member_id)
    REFERENCES claudian_cloud.project_memberships(project_id, member_id),
  CONSTRAINT ticket_comments_comment_id_format
    CHECK (comment_id ~ '^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$'),
  CONSTRAINT ticket_comments_body_present
    CHECK (body <> '')
);

CREATE TABLE claudian_cloud.request_ticket_relations (
  project_id varchar(64) NOT NULL,
  relation_id varchar(128) NOT NULL,
  request_id varchar(128) NOT NULL,
  ticket_id varchar(128) NOT NULL,
  commit_oid varchar(64) NOT NULL,
  kind text NOT NULL,
  state text NOT NULL,
  created_by_member_id varchar(64) NOT NULL,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  accepted_at timestamptz,
  accepted_merge_oid varchar(64),
  PRIMARY KEY (project_id, relation_id),
  CONSTRAINT request_ticket_relations_project
    FOREIGN KEY (project_id)
    REFERENCES claudian_cloud.projects(project_id)
    ON DELETE CASCADE,
  CONSTRAINT request_ticket_relations_request
    FOREIGN KEY (project_id, request_id)
    REFERENCES claudian_cloud.change_requests(project_id, request_id),
  CONSTRAINT request_ticket_relations_ticket
    FOREIGN KEY (project_id, ticket_id)
    REFERENCES claudian_cloud.tickets(project_id, ticket_id),
  CONSTRAINT request_ticket_relations_creator
    FOREIGN KEY (project_id, created_by_member_id)
    REFERENCES claudian_cloud.project_memberships(project_id, member_id),
  CONSTRAINT request_ticket_relations_ticket_unique
    UNIQUE (project_id, request_id, ticket_id),
  CONSTRAINT request_ticket_relations_relation_id_format
    CHECK (relation_id ~ '^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$'),
  CONSTRAINT request_ticket_relations_commit_oid_format
    CHECK (commit_oid ~ '^(?:[0-9a-f]{40}|[0-9a-f]{64})$'),
  CONSTRAINT request_ticket_relations_kind
    CHECK (kind IN ('references', 'resolves')),
  CONSTRAINT request_ticket_relations_state
    CHECK (state IN ('pending', 'accepted')),
  CONSTRAINT request_ticket_relations_accepted_merge_oid_format
    CHECK (
      accepted_merge_oid IS NULL
      OR accepted_merge_oid ~ '^(?:[0-9a-f]{40}|[0-9a-f]{64})$'
    ),
  CONSTRAINT request_ticket_relations_acceptance_state
    CHECK (
      (state = 'pending' AND accepted_at IS NULL AND accepted_merge_oid IS NULL)
      OR (
        state = 'accepted'
        AND accepted_at IS NOT NULL
        AND accepted_merge_oid IS NOT NULL
      )
    ),
  CONSTRAINT request_ticket_relations_timestamps
    CHECK (updated_at >= created_at AND (accepted_at IS NULL OR accepted_at >= created_at)),
  CONSTRAINT request_ticket_relations_accept_journal_identity
  UNIQUE (project_id, relation_id, request_id, ticket_id)
);

CREATE TABLE claudian_cloud.ticket_mentions (
  project_id varchar(64) NOT NULL,
  ticket_id varchar(128) NOT NULL,
  mentioned_member_id varchar(64) NOT NULL,
  source_kind text NOT NULL,
  source_id varchar(128) NOT NULL,
  created_at timestamptz NOT NULL,
  PRIMARY KEY (
    project_id,
    ticket_id,
    source_kind,
    source_id,
    mentioned_member_id
  ),
  CONSTRAINT ticket_mentions_project
    FOREIGN KEY (project_id)
    REFERENCES claudian_cloud.projects(project_id)
    ON DELETE CASCADE,
  CONSTRAINT ticket_mentions_ticket
    FOREIGN KEY (project_id, ticket_id)
    REFERENCES claudian_cloud.tickets(project_id, ticket_id),
  CONSTRAINT ticket_mentions_member
    FOREIGN KEY (project_id, mentioned_member_id)
    REFERENCES claudian_cloud.project_memberships(project_id, member_id),
  CONSTRAINT ticket_mentions_source_kind
    CHECK (source_kind IN ('description', 'comment')),
  CONSTRAINT ticket_mentions_source_id_format
    CHECK (source_id ~ '^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$'),
  CONSTRAINT ticket_mentions_description_source
    CHECK (source_kind <> 'description' OR source_id = ticket_id)
);

CREATE TABLE claudian_cloud.idempotency_results (
  project_id varchar(64) NOT NULL,
  member_id varchar(64) NOT NULL,
  operation text NOT NULL,
  idempotency_key varchar(128) NOT NULL,
  request_fingerprint char(64) NOT NULL,
  response_json jsonb NOT NULL,
  created_at timestamptz NOT NULL,
  PRIMARY KEY (project_id, member_id, operation, idempotency_key),
  CONSTRAINT idempotency_results_project
    FOREIGN KEY (project_id)
    REFERENCES claudian_cloud.projects(project_id)
    ON DELETE CASCADE,
  CONSTRAINT idempotency_results_member
    FOREIGN KEY (project_id, member_id)
    REFERENCES claudian_cloud.project_memberships(project_id, member_id),
  CONSTRAINT idempotency_results_operation_format
    CHECK (operation ~ '^[a-z][A-Za-z0-9]{0,63}$'),
  CONSTRAINT idempotency_results_key_format
    CHECK (idempotency_key ~ '^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$'),
  CONSTRAINT idempotency_results_fingerprint_format
    CHECK (request_fingerprint ~ '^[0-9a-f]{64}$'),
  CONSTRAINT idempotency_results_response_object
    CHECK (jsonb_typeof(response_json) = 'object'),
  CONSTRAINT idempotency_results_response_size
    CHECK (octet_length(response_json::text) BETWEEN 2 AND 524288)
);

CREATE TABLE claudian_cloud.accept_journals (
  project_id varchar(64) NOT NULL,
  operation_id varchar(128) NOT NULL,
  phase text NOT NULL,
  recovery_from_phase text,
  result_kind text NOT NULL,
  actor_member_id varchar(64) NOT NULL,
  request_member_id varchar(64) NOT NULL,
  request_id varchar(128) NOT NULL,
  idempotency_key varchar(128) NOT NULL,
  request_fingerprint char(64) NOT NULL,
  expected_request_revision bigint NOT NULL,
  expected_main_oid varchar(64) NOT NULL,
  expected_head_oid varchar(64) NOT NULL,
  main_ref varchar(255) NOT NULL,
  personal_ref varchar(255) NOT NULL,
  object_format text NOT NULL,
  storage_node_id varchar(64) NOT NULL,
  repository_storage_key varchar(128) NOT NULL,
  placement_generation bigint NOT NULL,
  prepared_at timestamptz NOT NULL,
  tree_oid varchar(64),
  first_parent_oid varchar(64),
  second_parent_oid varchar(64),
  author_name varchar(200),
  author_email varchar(200),
  committer_name varchar(200),
  committer_email varchar(200),
  commit_timezone char(5),
  commit_message bytea,
  result_oid varchar(64),
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  PRIMARY KEY (project_id, operation_id),
  CONSTRAINT accept_journals_project
    FOREIGN KEY (project_id)
    REFERENCES claudian_cloud.projects(project_id)
    ON DELETE CASCADE,
  CONSTRAINT accept_journals_actor
    FOREIGN KEY (project_id, actor_member_id)
    REFERENCES claudian_cloud.project_memberships(project_id, member_id),
  CONSTRAINT accept_journals_request_member
    FOREIGN KEY (project_id, request_member_id)
    REFERENCES claudian_cloud.project_memberships(project_id, member_id),
  CONSTRAINT accept_journals_request
    FOREIGN KEY (project_id, request_id)
    REFERENCES claudian_cloud.change_requests(project_id, request_id),
  CONSTRAINT accept_journals_request_identity
    UNIQUE (project_id, operation_id, request_id),
  CONSTRAINT accept_journals_idempotency_identity
    UNIQUE (project_id, actor_member_id, idempotency_key),
  CONSTRAINT accept_journals_operation_id_format
    CHECK (operation_id ~ '^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$'),
  CONSTRAINT accept_journals_idempotency_key_format
    CHECK (idempotency_key ~ '^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$'),
  CONSTRAINT accept_journals_fingerprint_format
    CHECK (request_fingerprint ~ '^[0-9a-f]{64}$'),
  CONSTRAINT accept_journals_phase
    CHECK (
      phase IN (
        'prepared',
        'result-persisted',
        'main-updated',
        'completed',
        'recovery-required'
      )
    ),
  CONSTRAINT accept_journals_recovery_phase
    CHECK (
      (
        phase <> 'recovery-required'
        AND recovery_from_phase IS NULL
      )
      OR (
        phase = 'recovery-required'
        AND recovery_from_phase IN ('prepared', 'result-persisted', 'main-updated')
      )
    ),
  CONSTRAINT accept_journals_result_kind
    CHECK (result_kind IN ('contained', 'merge')),
  CONSTRAINT accept_journals_request_revision
    CHECK (expected_request_revision BETWEEN 1 AND 9007199254740991),
  CONSTRAINT accept_journals_ref_identity
    CHECK (
      main_ref = 'refs/heads/main'
      AND personal_ref = 'refs/heads/members/' || request_member_id
    ),
  CONSTRAINT accept_journals_object_format
    CHECK (object_format IN ('sha1', 'sha256')),
  CONSTRAINT accept_journals_oid_format
    CHECK (
      expected_main_oid ~ '^(?:[0-9a-f]{40}|[0-9a-f]{64})$'
      AND expected_head_oid ~ '^(?:[0-9a-f]{40}|[0-9a-f]{64})$'
      AND (
        tree_oid IS NULL
        OR tree_oid ~ '^(?:[0-9a-f]{40}|[0-9a-f]{64})$'
      )
      AND (
        first_parent_oid IS NULL
        OR first_parent_oid ~ '^(?:[0-9a-f]{40}|[0-9a-f]{64})$'
      )
      AND (
        second_parent_oid IS NULL
        OR second_parent_oid ~ '^(?:[0-9a-f]{40}|[0-9a-f]{64})$'
      )
      AND (
        result_oid IS NULL
        OR result_oid ~ '^(?:[0-9a-f]{40}|[0-9a-f]{64})$'
      )
    ),
  CONSTRAINT accept_journals_oid_object_format
    CHECK (
      (
        object_format = 'sha1'
        AND length(expected_main_oid) = 40
        AND length(expected_head_oid) = 40
        AND (tree_oid IS NULL OR length(tree_oid) = 40)
        AND (first_parent_oid IS NULL OR length(first_parent_oid) = 40)
        AND (second_parent_oid IS NULL OR length(second_parent_oid) = 40)
        AND (result_oid IS NULL OR length(result_oid) = 40)
      )
      OR (
        object_format = 'sha256'
        AND length(expected_main_oid) = 64
        AND length(expected_head_oid) = 64
        AND (tree_oid IS NULL OR length(tree_oid) = 64)
        AND (first_parent_oid IS NULL OR length(first_parent_oid) = 64)
        AND (second_parent_oid IS NULL OR length(second_parent_oid) = 64)
        AND (result_oid IS NULL OR length(result_oid) = 64)
      )
    ),
  CONSTRAINT accept_journals_storage_node
    CHECK (storage_node_id ~ '^[a-z0-9]([a-z0-9._-]{0,62}[a-z0-9])?$'),
  CONSTRAINT accept_journals_storage_key
    CHECK (repository_storage_key ~ '^[a-z0-9][a-z0-9_-]{0,127}$'),
  CONSTRAINT accept_journals_placement_generation
    CHECK (placement_generation BETWEEN 1 AND 9007199254740991),
  CONSTRAINT accept_journals_prepared_second
    CHECK (prepared_at = date_trunc('second', prepared_at)),
  CONSTRAINT accept_journals_deterministic_plan
    CHECK (
      (
        result_kind = 'contained'
        AND tree_oid IS NULL
        AND first_parent_oid IS NULL
        AND second_parent_oid IS NULL
        AND author_name IS NULL
        AND author_email IS NULL
        AND committer_name IS NULL
        AND committer_email IS NULL
        AND commit_timezone IS NULL
        AND commit_message IS NULL
      )
      OR (
        result_kind = 'merge'
        AND tree_oid IS NOT NULL
        AND first_parent_oid = expected_main_oid
        AND second_parent_oid = expected_head_oid
        AND author_name = 'Claudian Collab'
        AND author_email = 'collab@claudian.local'
        AND committer_name = 'Claudian Collab'
        AND committer_email = 'collab@claudian.local'
        AND commit_timezone = '+0000'
        AND commit_message = convert_to(
          'Accept request ' || request_id || E'\n',
          'UTF8'
        )
      )
    ),
  CONSTRAINT accept_journals_result_phase
    CHECK (
      (
        phase = 'prepared'
        AND result_oid IS NULL
      )
      OR (
        phase IN ('result-persisted', 'main-updated', 'completed')
        AND result_oid IS NOT NULL
      )
      OR (
        phase = 'recovery-required'
        AND (
          (recovery_from_phase = 'prepared' AND result_oid IS NULL)
          OR (
            recovery_from_phase IN ('result-persisted', 'main-updated')
            AND result_oid IS NOT NULL
          )
        )
      )
    ),
  CONSTRAINT accept_journals_contained_result
    CHECK (
      result_kind <> 'contained'
      OR result_oid IS NULL
      OR result_oid = expected_main_oid
    ),
  CONSTRAINT accept_journals_timestamps
    CHECK (
      created_at = prepared_at
      AND updated_at >= created_at
    )
);

CREATE TABLE claudian_cloud.accept_journal_relations (
  project_id varchar(64) NOT NULL,
  operation_id varchar(128) NOT NULL,
  request_id varchar(128) NOT NULL,
  relation_id varchar(128) NOT NULL,
  ticket_id varchar(128) NOT NULL,
  ticket_revision bigint NOT NULL,
  commit_oid varchar(64) NOT NULL,
  kind text NOT NULL,
  PRIMARY KEY (project_id, operation_id, relation_id),
  CONSTRAINT accept_journal_relations_journal
    FOREIGN KEY (project_id, operation_id, request_id)
    REFERENCES claudian_cloud.accept_journals(
      project_id,
      operation_id,
      request_id
    )
    ON DELETE CASCADE,
  CONSTRAINT accept_journal_relations_relation
    FOREIGN KEY (project_id, relation_id, request_id, ticket_id)
    REFERENCES claudian_cloud.request_ticket_relations(
      project_id,
      relation_id,
      request_id,
      ticket_id
    ),
  CONSTRAINT accept_journal_relations_ticket
    FOREIGN KEY (project_id, ticket_id)
    REFERENCES claudian_cloud.tickets(project_id, ticket_id),
  CONSTRAINT accept_journal_relations_ticket_unique
    UNIQUE (project_id, operation_id, ticket_id),
  CONSTRAINT accept_journal_relations_relation_id_format
    CHECK (relation_id ~ '^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$'),
  CONSTRAINT accept_journal_relations_ticket_revision
    CHECK (ticket_revision BETWEEN 1 AND 9007199254740991),
  CONSTRAINT accept_journal_relations_commit_oid
    CHECK (commit_oid ~ '^(?:[0-9a-f]{40}|[0-9a-f]{64})$'),
  CONSTRAINT accept_journal_relations_kind
    CHECK (kind IN ('references', 'resolves'))
);

CREATE TABLE claudian_cloud.project_lifecycle_journals (
  project_id varchar(64) NOT NULL,
  operation_id varchar(128) NOT NULL,
  kind text NOT NULL,
  direction text,
  phase varchar(64) NOT NULL,
  recovery_from_phase varchar(64),
  state text NOT NULL,
  expected_authority_generation bigint NOT NULL,
  actor_member_id varchar(64),
  idempotency_key varchar(128) NOT NULL,
  request_fingerprint char(64) NOT NULL,
  checkpoint_sha256 char(64),
  batch_revision bigint,
  batch_sha256 char(64),
  result_sha256 char(64),
  scheduled_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  expected_personal_ref_oid varchar(64),
  PRIMARY KEY (project_id, operation_id),
  CONSTRAINT project_lifecycle_journals_project_id
    CHECK (project_id ~ '^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$'),
  CONSTRAINT project_lifecycle_journals_operation_id
    CHECK (operation_id ~ '^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$'),
  CONSTRAINT project_lifecycle_journals_direction
    CHECK (
      (
        kind = 'authority-transfer'
        AND direction IN ('lan-to-cloud', 'cloud-to-lan')
      )
      OR (kind <> 'authority-transfer' AND direction IS NULL)
    ),
  CONSTRAINT project_lifecycle_journals_phase
    CHECK (phase ~ '^[a-z][a-z0-9-]{0,63}$'),
  CONSTRAINT project_lifecycle_journals_recovery_phase
    CHECK (
      (state = 'recovery-required' AND recovery_from_phase IS NOT NULL)
      OR (state <> 'recovery-required' AND recovery_from_phase IS NULL)
    ),
  CONSTRAINT project_lifecycle_journals_recovery_phase_format
    CHECK (
      recovery_from_phase IS NULL
      OR recovery_from_phase ~ '^[a-z][a-z0-9-]{0,63}$'
    ),
  CONSTRAINT project_lifecycle_journals_state
    CHECK (state IN ('active', 'cancelled', 'completed', 'recovery-required')),
  CONSTRAINT project_lifecycle_journals_generation
    CHECK (expected_authority_generation BETWEEN 1 AND 9007199254740991),
  CONSTRAINT project_lifecycle_journals_actor
    CHECK (
      actor_member_id IS NULL
      OR actor_member_id ~ '^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$'
    ),
  CONSTRAINT project_lifecycle_journals_idempotency_key
    CHECK (idempotency_key ~ '^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$'),
  CONSTRAINT project_lifecycle_journals_request_fingerprint
    CHECK (request_fingerprint ~ '^[0-9a-f]{64}$'),
  CONSTRAINT project_lifecycle_journals_checkpoint
    CHECK (checkpoint_sha256 IS NULL OR checkpoint_sha256 ~ '^[0-9a-f]{64}$'),
  CONSTRAINT project_lifecycle_journals_batch
    CHECK (
      (batch_revision IS NULL AND batch_sha256 IS NULL)
      OR (
        batch_revision BETWEEN 1 AND 9007199254740991
        AND batch_sha256 ~ '^[0-9a-f]{64}$'
        AND checkpoint_sha256 IS NOT NULL
      )
    ),
  CONSTRAINT project_lifecycle_journals_result
    CHECK (result_sha256 IS NULL OR result_sha256 ~ '^[0-9a-f]{64}$'),
  CONSTRAINT project_lifecycle_journals_timestamps
    CHECK (scheduled_at >= created_at AND updated_at >= created_at),
  CONSTRAINT project_lifecycle_journals_kind
    CHECK (kind IN (
      'authority-transfer', 'backup', 'delete', 'export', 'leave',
      'remove-member', 'retire'
    )),
  CONSTRAINT project_lifecycle_journals_leave_ref
    CHECK (
      (kind IN ('leave', 'remove-member'))
        = (expected_personal_ref_oid IS NOT NULL)
      AND (
        expected_personal_ref_oid IS NULL
        OR expected_personal_ref_oid ~ '^(?:[0-9a-f]{40}|[0-9a-f]{64})$'
      )
    )
);

CREATE TABLE claudian_cloud.project_principal_bindings (
  project_id varchar(64) NOT NULL,
  principal_id varchar(128) NOT NULL,
  member_id varchar(64) NOT NULL,
  state text NOT NULL,
  bound_at timestamptz NOT NULL,
  revoked_at timestamptz,
  PRIMARY KEY (project_id, principal_id),
  CONSTRAINT project_principal_bindings_membership
    FOREIGN KEY (project_id, member_id)
    REFERENCES claudian_cloud.project_memberships(project_id, member_id),
  CONSTRAINT project_principal_bindings_principal
    CHECK (principal_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'),
  CONSTRAINT project_principal_bindings_member
    CHECK (member_id ~ '^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$'),
  CONSTRAINT project_principal_bindings_state
    CHECK (
      (state IN ('active', 'pending') AND revoked_at IS NULL)
      OR (state = 'revoked' AND revoked_at >= bound_at)
    )
);

CREATE TABLE claudian_cloud.authority_transfer_recovery (
  project_id varchar(64) NOT NULL,
  transfer_id varchar(128) NOT NULL,
  source_authority_kind text NOT NULL,
  source_authority_generation bigint NOT NULL,
  target_authority_kind text NOT NULL,
  target_authority_generation bigint NOT NULL,
  source_host_member_id varchar(64),
  target_host_member_id varchar(64),
  target_url varchar(2048) NOT NULL,
  expires_at timestamptz NOT NULL,
  source_proof text,
  target_proof text,
  stage_sha256 char(64),
  target_activation_proof text,
  relinquishment_proof_json text,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  cancellation_request_sha256 char(64),
  source_reopen_sha256 char(64),
  inactive_publication_json text,
  target_activation_request_sha256 char(64),
  PRIMARY KEY (project_id, transfer_id),
  CONSTRAINT authority_transfer_recovery_journal
    FOREIGN KEY (project_id, transfer_id)
    REFERENCES claudian_cloud.project_lifecycle_journals(project_id, operation_id),
  CONSTRAINT authority_transfer_recovery_authorities
    CHECK (
      source_authority_kind IN ('cloud', 'lan')
      AND target_authority_kind IN ('cloud', 'lan')
      AND source_authority_kind <> target_authority_kind
      AND source_authority_generation BETWEEN 1 AND 9007199254740991
      AND target_authority_generation = source_authority_generation + 1
    ),
  CONSTRAINT authority_transfer_recovery_hosts
    CHECK (
      (
        source_authority_kind = 'lan'
        AND source_host_member_id ~ '^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$'
        AND target_host_member_id IS NULL
      )
      OR (
        source_authority_kind = 'cloud'
        AND source_host_member_id IS NULL
        AND target_host_member_id ~ '^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$'
      )
    ),
  CONSTRAINT authority_transfer_recovery_target_url
    CHECK (octet_length(target_url) BETWEEN 1 AND 2048),
  CONSTRAINT authority_transfer_recovery_proofs
    CHECK (
      (source_proof IS NULL OR octet_length(source_proof) BETWEEN 1 AND 8192)
      AND (target_proof IS NULL OR octet_length(target_proof) BETWEEN 1 AND 8192)
      AND (stage_sha256 IS NULL OR stage_sha256 ~ '^[0-9a-f]{64}$')
      AND (
        target_activation_proof IS NULL
        OR octet_length(target_activation_proof) BETWEEN 1 AND 8192
      )
      AND (
        relinquishment_proof_json IS NULL
        OR octet_length(relinquishment_proof_json) BETWEEN 2 AND 65536
      )
    ),
  CONSTRAINT authority_transfer_recovery_timestamps
    CHECK (expires_at > created_at AND updated_at >= created_at),
  CONSTRAINT authority_transfer_recovery_lan_to_cloud_evidence
    CHECK (
      (
        cancellation_request_sha256 IS NULL
        OR cancellation_request_sha256 ~ '^[0-9a-f]{64}$'
      )
      AND (
        source_reopen_sha256 IS NULL
        OR source_reopen_sha256 ~ '^[0-9a-f]{64}$'
      )
      AND (
        inactive_publication_json IS NULL
        OR octet_length(inactive_publication_json) BETWEEN 2 AND 262144
      )
    ),
  CONSTRAINT authority_transfer_recovery_activation_request
    CHECK (
      target_activation_request_sha256 IS NULL
      OR target_activation_request_sha256 ~ '^[0-9a-f]{64}$'
    )
);

CREATE TABLE claudian_cloud.transferred_membership_claims (
  project_id varchar(64) NOT NULL,
  transfer_id varchar(128) NOT NULL,
  member_id varchar(64) NOT NULL,
  batch_revision bigint NOT NULL,
  checkpoint_sha256 char(64) NOT NULL,
  claim_sha256 char(64) NOT NULL,
  state text NOT NULL,
  target_principal_id varchar(128),
  operation_intent_id varchar(128),
  redemption_receipt_id varchar(128),
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  PRIMARY KEY (project_id, transfer_id, batch_revision, member_id),
  CONSTRAINT transferred_membership_claims_transfer
    FOREIGN KEY (project_id, transfer_id)
    REFERENCES claudian_cloud.project_lifecycle_journals(project_id, operation_id),
  CONSTRAINT transferred_membership_claims_member
    CHECK (member_id ~ '^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$'),
  CONSTRAINT transferred_membership_claims_batch_revision
    CHECK (batch_revision BETWEEN 1 AND 9007199254740991),
  CONSTRAINT transferred_membership_claims_digests
    CHECK (
      checkpoint_sha256 ~ '^[0-9a-f]{64}$'
      AND claim_sha256 ~ '^[0-9a-f]{64}$'
    ),
  CONSTRAINT transferred_membership_claims_state
    CHECK (state IN ('unclaimed', 'redeemed', 'revoked')),
  CONSTRAINT transferred_membership_claims_binding
    CHECK (
      (
        state = 'unclaimed'
        AND target_principal_id IS NULL
        AND operation_intent_id IS NULL
        AND redemption_receipt_id IS NULL
      )
      OR (
        state = 'redeemed'
        AND target_principal_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
        AND operation_intent_id ~ '^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$'
        AND redemption_receipt_id ~ '^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$'
      )
      OR state = 'revoked'
    ),
  CONSTRAINT transferred_membership_claims_expiry
    CHECK (expires_at > created_at AND updated_at >= created_at),
  UNIQUE (project_id, transfer_id, claim_sha256)
);

CREATE TABLE claudian_cloud.transfer_receipt_keys (
  project_id varchar(64) NOT NULL,
  transfer_id varchar(128) NOT NULL,
  receipt_key_id varchar(128) NOT NULL,
  signature_algorithm text NOT NULL,
  public_key text NOT NULL,
  created_at timestamptz NOT NULL,
  PRIMARY KEY (project_id, transfer_id, receipt_key_id),
  CONSTRAINT transfer_receipt_keys_transfer
    FOREIGN KEY (project_id, transfer_id)
    REFERENCES claudian_cloud.project_lifecycle_journals(project_id, operation_id),
  CONSTRAINT transfer_receipt_keys_key_id
    CHECK (receipt_key_id ~ '^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$'),
  CONSTRAINT transfer_receipt_keys_algorithm
    CHECK (signature_algorithm = 'ed25519'),
  CONSTRAINT transfer_receipt_keys_public_key
    CHECK (
      octet_length(public_key) BETWEEN 40 AND 128
      AND public_key ~ '^[A-Za-z0-9_-]+$'
    )
);

CREATE TABLE claudian_cloud.source_protected_claim_envelopes (
  project_id varchar(64) NOT NULL,
  transfer_id varchar(128) NOT NULL,
  member_id varchar(64) NOT NULL,
  claim_sha256 char(64) NOT NULL,
  checkpoint_sha256 char(64) NOT NULL,
  environment_identity varchar(128) NOT NULL,
  authority_generation bigint NOT NULL,
  envelope_version integer NOT NULL,
  encryption_algorithm text NOT NULL,
  key_id varchar(128) NOT NULL,
  key_version integer NOT NULL,
  receipt_key_id varchar(128) NOT NULL,
  associated_data_sha256 char(64) NOT NULL,
  nonce text NOT NULL,
  ciphertext text NOT NULL,
  tag text NOT NULL,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL,
  PRIMARY KEY (project_id, transfer_id, member_id),
  CONSTRAINT source_protected_claim_envelopes_transfer
    FOREIGN KEY (project_id, transfer_id)
    REFERENCES claudian_cloud.project_lifecycle_journals(project_id, operation_id),
  CONSTRAINT source_protected_claim_envelopes_receipt_key
    FOREIGN KEY (project_id, transfer_id, receipt_key_id)
    REFERENCES claudian_cloud.transfer_receipt_keys(project_id, transfer_id, receipt_key_id),
  CONSTRAINT source_protected_claim_envelopes_member
    CHECK (member_id ~ '^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$'),
  CONSTRAINT source_protected_claim_envelopes_digests
    CHECK (
      claim_sha256 ~ '^[0-9a-f]{64}$'
      AND checkpoint_sha256 ~ '^[0-9a-f]{64}$'
      AND associated_data_sha256 ~ '^[0-9a-f]{64}$'
    ),
  CONSTRAINT source_protected_claim_envelopes_environment
    CHECK (environment_identity ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'),
  CONSTRAINT source_protected_claim_envelopes_generation
    CHECK (authority_generation BETWEEN 1 AND 9007199254740991),
  CONSTRAINT source_protected_claim_envelopes_version
    CHECK (envelope_version = 1 AND key_version BETWEEN 1 AND 2147483647),
  CONSTRAINT source_protected_claim_envelopes_algorithm
    CHECK (encryption_algorithm = 'xchacha20-poly1305'),
  CONSTRAINT source_protected_claim_envelopes_key_ids
    CHECK (
      key_id ~ '^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$'
      AND receipt_key_id ~ '^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$'
    ),
  CONSTRAINT source_protected_claim_envelopes_nonce
    CHECK (octet_length(nonce) = 32 AND nonce ~ '^[A-Za-z0-9_-]+$'),
  CONSTRAINT source_protected_claim_envelopes_ciphertext
    CHECK (octet_length(ciphertext) BETWEEN 1 AND 5462 AND ciphertext ~ '^[A-Za-z0-9_-]+$'),
  CONSTRAINT source_protected_claim_envelopes_tag
    CHECK (octet_length(tag) = 22 AND tag ~ '^[A-Za-z0-9_-]+$'),
  CONSTRAINT source_protected_claim_envelopes_expiry
    CHECK (expires_at > created_at),
  UNIQUE (project_id, transfer_id, claim_sha256)
);

CREATE TABLE claudian_cloud.transfer_claim_batch_receipts (
  project_id varchar(64) NOT NULL,
  transfer_id varchar(128) NOT NULL,
  batch_revision bigint NOT NULL,
  batch_sha256 char(64) NOT NULL,
  checkpoint_sha256 char(64) NOT NULL,
  operation_intent_id varchar(128) NOT NULL,
  submitted_by_member_id varchar(64) NOT NULL,
  custody_authority_kind text NOT NULL,
  custody_authority_generation bigint NOT NULL,
  receipt_id varchar(128) NOT NULL,
  receipt_json text NOT NULL,
  committed_at timestamptz NOT NULL,
  PRIMARY KEY (project_id, transfer_id),
  CONSTRAINT transfer_claim_batch_receipts_transfer
    FOREIGN KEY (project_id, transfer_id)
    REFERENCES claudian_cloud.project_lifecycle_journals(project_id, operation_id),
  CONSTRAINT transfer_claim_batch_receipts_batch
    CHECK (
      batch_revision BETWEEN 1 AND 9007199254740991
      AND batch_sha256 ~ '^[0-9a-f]{64}$'
      AND checkpoint_sha256 ~ '^[0-9a-f]{64}$'
    ),
  CONSTRAINT transfer_claim_batch_receipts_identity
    CHECK (
      operation_intent_id ~ '^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$'
      AND submitted_by_member_id ~ '^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$'
      AND receipt_id ~ '^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$'
    ),
  CONSTRAINT transfer_claim_batch_receipts_authority
    CHECK (
      custody_authority_kind IN ('cloud', 'lan')
      AND custody_authority_generation BETWEEN 1 AND 9007199254740991
    ),
  CONSTRAINT transfer_claim_batch_receipts_json
    CHECK (octet_length(receipt_json) BETWEEN 2 AND 65536)
);

CREATE TABLE claudian_cloud.transfer_redemption_receipts (
  project_id varchar(64) NOT NULL,
  transfer_id varchar(128) NOT NULL,
  member_id varchar(64) NOT NULL,
  receipt_id varchar(128) NOT NULL,
  claim_sha256 char(64) NOT NULL,
  operation_intent_id varchar(128) NOT NULL,
  receipt_key_id varchar(128) NOT NULL,
  receipt_json text NOT NULL,
  redeemed_at timestamptz NOT NULL,
  acknowledged_at timestamptz,
  PRIMARY KEY (project_id, transfer_id, member_id),
  CONSTRAINT transfer_redemption_receipts_transfer
    FOREIGN KEY (project_id, transfer_id)
    REFERENCES claudian_cloud.project_lifecycle_journals(project_id, operation_id),
  CONSTRAINT transfer_redemption_receipts_receipt_key
    FOREIGN KEY (project_id, transfer_id, receipt_key_id)
    REFERENCES claudian_cloud.transfer_receipt_keys(project_id, transfer_id, receipt_key_id),
  CONSTRAINT transfer_redemption_receipts_member
    CHECK (member_id ~ '^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$'),
  CONSTRAINT transfer_redemption_receipts_identity
    CHECK (
      receipt_id ~ '^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$'
      AND operation_intent_id ~ '^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$'
      AND receipt_key_id ~ '^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$'
      AND claim_sha256 ~ '^[0-9a-f]{64}$'
    ),
  CONSTRAINT transfer_redemption_receipts_json
    CHECK (octet_length(receipt_json) BETWEEN 2 AND 65536),
  CONSTRAINT transfer_redemption_receipts_acknowledged
    CHECK (acknowledged_at IS NULL OR acknowledged_at >= redeemed_at),
  UNIQUE (project_id, transfer_id, receipt_id)
);

CREATE TABLE claudian_cloud.project_terminal_responders (
  project_id varchar(64) NOT NULL,
  operation_kind text NOT NULL,
  operation_id varchar(128) NOT NULL,
  response_sha256 char(64) NOT NULL,
  response_json text NOT NULL,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  replay_member_id varchar(64),
  replay_request_sha256 char(64),
  PRIMARY KEY (project_id, operation_kind, operation_id),
  CONSTRAINT project_terminal_responders_project_id
    CHECK (project_id ~ '^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$'),
  CONSTRAINT project_terminal_responders_operation
    CHECK (
      operation_kind IN ('authority-transfer', 'retire')
      AND operation_id ~ '^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$'
    ),
  CONSTRAINT project_terminal_responders_response
    CHECK (
      response_sha256 ~ '^[0-9a-f]{64}$'
      AND octet_length(response_json) BETWEEN 2 AND 262144
    ),
  CONSTRAINT project_terminal_responders_expiry
    CHECK (expires_at > created_at AND updated_at >= created_at),
  CONSTRAINT project_terminal_responders_replay
    CHECK (
      (
        operation_kind = 'authority-transfer'
        AND replay_member_id IS NOT NULL
        AND replay_member_id ~ '^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$'
        AND replay_request_sha256 IS NOT NULL
        AND replay_request_sha256 ~ '^[0-9a-f]{64}$'
      )
      OR (
        operation_kind = 'retire'
        AND replay_member_id IS NULL
        AND replay_request_sha256 IS NULL
      )
    )
);

CREATE TABLE claudian_cloud.project_terminal_responder_catalog (
  project_id varchar(64) NOT NULL,
  operation_kind text NOT NULL,
  operation_id varchar(128) NOT NULL,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL,
  PRIMARY KEY (project_id, operation_kind, operation_id),
  CONSTRAINT project_terminal_responder_catalog_responder
    FOREIGN KEY (project_id, operation_kind, operation_id)
    REFERENCES claudian_cloud.project_terminal_responders(
      project_id,
      operation_kind,
      operation_id
    )
    ON DELETE CASCADE,
  CONSTRAINT project_terminal_responder_catalog_project_id
    CHECK (project_id ~ '^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$'),
  CONSTRAINT project_terminal_responder_catalog_operation
    CHECK (
      operation_kind IN ('authority-transfer', 'retire')
      AND operation_id ~ '^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$'
    ),
  CONSTRAINT project_terminal_responder_catalog_expiry
    CHECK (expires_at > created_at)
);

CREATE TABLE claudian_cloud.project_terminal_acknowledgements (
  project_id varchar(64) NOT NULL,
  operation_kind text NOT NULL,
  operation_id varchar(128) NOT NULL,
  principal_id varchar(128) NOT NULL,
  member_id varchar(64) NOT NULL,
  acknowledged_at timestamptz,
  PRIMARY KEY (project_id, operation_kind, operation_id, member_id),
  CONSTRAINT project_terminal_acknowledgements_responder
    FOREIGN KEY (project_id, operation_kind, operation_id)
    REFERENCES claudian_cloud.project_terminal_responders(
      project_id,
      operation_kind,
      operation_id
    )
    ON DELETE CASCADE,
  CONSTRAINT project_terminal_acknowledgements_principal
    CHECK (principal_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'),
  CONSTRAINT project_terminal_acknowledgements_member
    CHECK (member_id ~ '^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$'),
  UNIQUE (project_id, operation_kind, operation_id, principal_id)
);

CREATE TABLE claudian_cloud.leave_former_principal_replays (
  project_id varchar(64) NOT NULL,
  operation_id varchar(128) NOT NULL,
  principal_sha256 char(64) NOT NULL,
  member_id varchar(64) NOT NULL,
  intent_id varchar(128) NOT NULL,
  request_fingerprint char(64) NOT NULL,
  state text NOT NULL,
  result_sha256 char(64),
  created_at timestamptz NOT NULL,
  completed_at timestamptz,
  expires_at timestamptz NOT NULL,
  expected_personal_ref_oid varchar(64) NOT NULL,
  response_json text NOT NULL,
  PRIMARY KEY (project_id, operation_id),
  CONSTRAINT leave_former_principal_replays_journal
    FOREIGN KEY (project_id, operation_id)
    REFERENCES claudian_cloud.project_lifecycle_journals(project_id, operation_id),
  CONSTRAINT leave_former_principal_replays_identity
    CHECK (
      principal_sha256 ~ '^[0-9a-f]{64}$'
      AND member_id ~ '^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$'
      AND intent_id ~ '^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$'
      AND request_fingerprint ~ '^[0-9a-f]{64}$'
    ),
  CONSTRAINT leave_former_principal_replays_state
    CHECK (
      (
        state = 'recovering'
        AND result_sha256 IS NULL
        AND completed_at IS NULL
      )
      OR (
        state = 'completed'
        AND result_sha256 ~ '^[0-9a-f]{64}$'
        AND completed_at >= created_at
      )
    ),
  CONSTRAINT leave_former_principal_replays_expiry
    CHECK (expires_at > created_at),
  CONSTRAINT leave_former_principal_replays_expected_ref
    CHECK (expected_personal_ref_oid ~ '^(?:[0-9a-f]{40}|[0-9a-f]{64})$'),
  CONSTRAINT leave_former_principal_replays_response
    CHECK (octet_length(response_json) BETWEEN 2 AND 65536)
);

CREATE TABLE claudian_cloud.project_tombstones (
  project_id varchar(64) NOT NULL,
  authority_generation bigint NOT NULL,
  terminal_operation_kind text NOT NULL,
  terminal_operation_id varchar(128) NOT NULL,
  result_sha256 char(64) NOT NULL,
  retired_at timestamptz NOT NULL,
  terminal_expires_at timestamptz NOT NULL,
  return_host_member_id varchar(64),
  return_principal_id text,
  return_authority_fingerprint char(64) CHECK (return_authority_fingerprint ~ '^[0-9a-f]{64}$'),
  PRIMARY KEY (project_id, terminal_operation_id),
  UNIQUE (project_id, authority_generation),
  CONSTRAINT project_tombstones_return_authority
    CHECK ((return_host_member_id IS NULL) = (return_principal_id IS NULL)
      AND (terminal_operation_kind = 'authority-transfer' OR return_principal_id IS NULL)),
  CONSTRAINT project_tombstones_project_id
    CHECK (project_id ~ '^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$'),
  CONSTRAINT project_tombstones_generation
    CHECK (authority_generation BETWEEN 1 AND 9007199254740991),
  CONSTRAINT project_tombstones_operation
    CHECK (
      terminal_operation_kind IN ('authority-transfer', 'retire')
      AND terminal_operation_id ~ '^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$'
    ),
  CONSTRAINT project_tombstones_digest
    CHECK (result_sha256 ~ '^[0-9a-f]{64}$'),
  CONSTRAINT project_tombstones_expiry
    CHECK (terminal_expires_at > retired_at),
  UNIQUE (project_id, terminal_operation_kind, terminal_operation_id)
);

CREATE TABLE claudian_cloud.project_deletion_intents (
  project_id varchar(64) NOT NULL,
  operation_id varchar(128) NOT NULL,
  reason text NOT NULL,
  authorized_member_id varchar(64) NOT NULL,
  authorization_sha256 char(64) NOT NULL,
  storage_node_id varchar(64) NOT NULL,
  repository_storage_key varchar(128) NOT NULL,
  placement_generation bigint NOT NULL,
  terminal_operation_kind text NOT NULL,
  terminal_operation_id varchar(128) NOT NULL,
  created_at timestamptz NOT NULL,
  PRIMARY KEY (project_id, operation_id),
  CONSTRAINT project_deletion_intents_journal
    FOREIGN KEY (project_id, operation_id)
    REFERENCES claudian_cloud.project_lifecycle_journals(project_id, operation_id),
  CONSTRAINT project_deletion_intents_tombstone
    FOREIGN KEY (project_id, terminal_operation_kind, terminal_operation_id)
    REFERENCES claudian_cloud.project_tombstones(
      project_id,
      terminal_operation_kind,
      terminal_operation_id
    ),
  CONSTRAINT project_deletion_intents_project_id
    CHECK (project_id ~ '^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$'),
  CONSTRAINT project_deletion_intents_operation_id
    CHECK (operation_id ~ '^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$'),
  CONSTRAINT project_deletion_intents_reason
    CHECK (reason IN ('cloud-to-lan', 'retire')),
  CONSTRAINT project_deletion_intents_member
    CHECK (authorized_member_id ~ '^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$'),
  CONSTRAINT project_deletion_intents_authorization
    CHECK (authorization_sha256 ~ '^[0-9a-f]{64}$'),
  CONSTRAINT project_deletion_intents_storage_node
    CHECK (storage_node_id ~ '^[a-z0-9]([a-z0-9._-]{0,62}[a-z0-9])?$'),
  CONSTRAINT project_deletion_intents_storage_key
    CHECK (repository_storage_key ~ '^[a-z0-9][a-z0-9_-]{0,127}$'),
  CONSTRAINT project_deletion_intents_generation
    CHECK (placement_generation BETWEEN 1 AND 9007199254740991),
  CONSTRAINT project_deletion_intents_terminal_operation
    CHECK (
      terminal_operation_kind IN ('authority-transfer', 'retire')
      AND terminal_operation_id ~ '^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$'
    ),
  CONSTRAINT project_deletion_intents_created_at
    CHECK (created_at > '-infinity'::timestamptz)
);

CREATE TABLE claudian_cloud.project_backup_catalog (
  project_id varchar(64) NOT NULL,
  backup_id varchar(128) NOT NULL,
  checkpoint_sha256 char(64) NOT NULL,
  authority_generation bigint NOT NULL,
  coordination_schema_version integer NOT NULL,
  server_build varchar(128) NOT NULL,
  authority_volume_identity varchar(128) NOT NULL,
  placement_generation bigint NOT NULL,
  state text NOT NULL,
  created_at timestamptz NOT NULL,
  verified_at timestamptz,
  published_at timestamptz,
  PRIMARY KEY (project_id, backup_id),
  CONSTRAINT project_backup_catalog_project_id
    CHECK (project_id ~ '^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$'),
  CONSTRAINT project_backup_catalog_backup_id
    CHECK (backup_id ~ '^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$'),
  CONSTRAINT project_backup_catalog_checkpoint
    CHECK (checkpoint_sha256 ~ '^[0-9a-f]{64}$'),
  CONSTRAINT project_backup_catalog_generations
    CHECK (
      authority_generation BETWEEN 1 AND 9007199254740991
      AND placement_generation BETWEEN 1 AND 9007199254740991
      AND coordination_schema_version BETWEEN 1 AND 2147483647
    ),
  CONSTRAINT project_backup_catalog_build
    CHECK (octet_length(server_build) BETWEEN 1 AND 128),
  CONSTRAINT project_backup_catalog_volume
    CHECK (authority_volume_identity ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'),
  CONSTRAINT project_backup_catalog_state
    CHECK (
      (state = 'captured' AND verified_at IS NULL AND published_at IS NULL)
      OR (state = 'verified' AND verified_at IS NOT NULL AND published_at IS NULL)
      OR (
        state = 'published'
        AND verified_at IS NOT NULL
        AND published_at IS NOT NULL
        AND published_at >= verified_at
      )
    ),
  CONSTRAINT project_backup_catalog_timestamps
    CHECK (verified_at IS NULL OR verified_at >= created_at)
);

CREATE TABLE claudian_cloud.project_terminal_continuity_catalog (
  project_id varchar(64) PRIMARY KEY,
  retired_at timestamptz NOT NULL,
  CONSTRAINT project_terminal_continuity_catalog_project_id
    CHECK (project_id ~ '^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$')
);

CREATE TABLE claudian_cloud.leave_project_request_facts (
  project_id varchar(64) NOT NULL,
  operation_id varchar(128) NOT NULL,
  expected_membership_revision bigint NOT NULL,
  expected_manager_set_generation bigint NOT NULL,
  manager_responsibility_offer_id varchar(128),
  expected_offer_revision bigint,
  PRIMARY KEY (project_id, operation_id),
  CONSTRAINT leave_project_request_facts_journal
    FOREIGN KEY (project_id, operation_id)
    REFERENCES claudian_cloud.project_lifecycle_journals(project_id, operation_id),
  CONSTRAINT leave_project_request_facts_expected
    CHECK (
      expected_membership_revision BETWEEN 1 AND 9007199254740991
      AND expected_manager_set_generation BETWEEN 1 AND 9007199254740991
    ),
  CONSTRAINT leave_project_request_facts_offer
    CHECK (
      (manager_responsibility_offer_id IS NULL AND expected_offer_revision IS NULL)
      OR (
        manager_responsibility_offer_id ~ '^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$'
        AND expected_offer_revision BETWEEN 1 AND 9007199254740991
      )
    )
);

CREATE TABLE claudian_cloud.cloud_project_creation_journals (
  project_id varchar(64) PRIMARY KEY,
  operation_id varchar(128) NOT NULL,
  phase text NOT NULL,
  principal_id varchar(128) NOT NULL,
  idempotency_key varchar(128) NOT NULL,
  request_fingerprint char(64) NOT NULL,
  project_name varchar(256) NOT NULL,
  member_id varchar(64) NOT NULL,
  manager_display_name varchar(128) NOT NULL,
  personal_ref varchar(255) NOT NULL,
  object_format text NOT NULL,
  empty_tree_oid varchar(64) NOT NULL,
  initial_commit_oid varchar(64) NOT NULL,
  commit_timestamp_seconds bigint NOT NULL,
  author_name varchar(200) NOT NULL,
  author_email varchar(200) NOT NULL,
  commit_timezone char(5) NOT NULL,
  commit_message bytea NOT NULL,
  main_ref varchar(255) NOT NULL,
  storage_node_id varchar(64) NOT NULL,
  repository_storage_key varchar(128) NOT NULL,
  placement_generation bigint NOT NULL,
  plan_sha256 char(64) NOT NULL,
  publication_marker_sha256 char(64),
  response_json text,
  prepared_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  CONSTRAINT cloud_project_creation_journals_project
    FOREIGN KEY (project_id)
    REFERENCES claudian_cloud.projects(project_id),
  CONSTRAINT cloud_project_creation_journals_member
    FOREIGN KEY (project_id, member_id)
    REFERENCES claudian_cloud.project_memberships(project_id, member_id),
  CONSTRAINT cloud_project_creation_journals_binding
    FOREIGN KEY (project_id, principal_id)
    REFERENCES claudian_cloud.project_principal_bindings(project_id, principal_id),
  CONSTRAINT cloud_project_creation_journals_operation_format
    CHECK (operation_id ~ '^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$'),
  CONSTRAINT cloud_project_creation_journals_principal_format
    CHECK (principal_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'),
  CONSTRAINT cloud_project_creation_journals_idempotency_format
    CHECK (idempotency_key ~ '^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$'),
  CONSTRAINT cloud_project_creation_journals_digest_format
    CHECK (
      request_fingerprint ~ '^[0-9a-f]{64}$'
      AND plan_sha256 ~ '^[0-9a-f]{64}$'
      AND (
        publication_marker_sha256 IS NULL
        OR publication_marker_sha256 ~ '^[0-9a-f]{64}$'
      )
    ),
  CONSTRAINT cloud_project_creation_journals_names
    CHECK (
      octet_length(project_name) BETWEEN 1 AND 256
      AND octet_length(manager_display_name) BETWEEN 1 AND 128
    ),
  CONSTRAINT cloud_project_creation_journals_phase
    CHECK (
      phase IN (
        'prepared',
        'repository-publication-intent',
        'repository-published',
        'activated',
        'completed'
      )
    ),
  CONSTRAINT cloud_project_creation_journals_ref_identity
    CHECK (
      main_ref = 'refs/heads/main'
      AND personal_ref = 'refs/heads/members/' || member_id
    ),
  CONSTRAINT cloud_project_creation_journals_commit
    CHECK (
      object_format = 'sha1'
      AND empty_tree_oid = '4b825dc642cb6eb9a060e54bf8d69288fbee4904'
      AND initial_commit_oid ~ '^[0-9a-f]{40}$'
      AND commit_timestamp_seconds BETWEEN 0 AND 9007199254740991
      AND author_name = 'Claudian Cloud'
      AND author_email = 'cloud@claudian.invalid'
      AND commit_timezone = '+0000'
      AND commit_message = convert_to('Initialize Collab project', 'UTF8')
    ),
  CONSTRAINT cloud_project_creation_journals_placement
    CHECK (
      storage_node_id ~ '^[a-z0-9]([a-z0-9._-]{0,62}[a-z0-9])?$'
      AND repository_storage_key ~ '^[a-z0-9][a-z0-9_-]{0,127}$'
      AND placement_generation = 1
    ),
  CONSTRAINT cloud_project_creation_journals_phase_facts
    CHECK (
      (
        phase IN ('prepared', 'repository-publication-intent')
        AND publication_marker_sha256 IS NULL
        AND response_json IS NULL
      )
      OR (
        phase = 'repository-published'
        AND publication_marker_sha256 IS NOT NULL
        AND response_json IS NULL
      )
      OR (
        phase IN ('activated', 'completed')
        AND publication_marker_sha256 IS NOT NULL
        AND octet_length(response_json) BETWEEN 2 AND 65536
      )
    ),
  CONSTRAINT cloud_project_creation_journals_timestamps
    CHECK (
      prepared_at = date_trunc('second', prepared_at)
      AND updated_at >= prepared_at
    )
);

CREATE TABLE claudian_cloud.project_invitations (
  project_id varchar(64) NOT NULL,
  invitation_id varchar(128) NOT NULL,
  issued_by_member_id varchar(64) NOT NULL,
  idempotency_key varchar(128) NOT NULL,
  request_fingerprint char(64) NOT NULL,
  secret_sha256 char(64) NOT NULL,
  state text NOT NULL,
  revision bigint NOT NULL,
  created_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  secret_replay_expires_at timestamptz NOT NULL,
  terminal_at timestamptz,
  PRIMARY KEY (project_id, invitation_id),
  CONSTRAINT project_invitations_project
    FOREIGN KEY (project_id)
    REFERENCES claudian_cloud.projects(project_id),
  CONSTRAINT project_invitations_issuer
    FOREIGN KEY (project_id, issued_by_member_id)
    REFERENCES claudian_cloud.project_memberships(project_id, member_id),
  CONSTRAINT project_invitations_identity
    UNIQUE (project_id, issued_by_member_id, idempotency_key),
  CONSTRAINT project_invitations_id_format
    CHECK (invitation_id ~ '^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$'),
  CONSTRAINT project_invitations_key_format
    CHECK (idempotency_key ~ '^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$'),
  CONSTRAINT project_invitations_digests
    CHECK (
      request_fingerprint ~ '^[0-9a-f]{64}$'
      AND secret_sha256 ~ '^[0-9a-f]{64}$'
    ),
  CONSTRAINT project_invitations_state
    CHECK (state IN ('active', 'redeeming', 'redeemed', 'revoked', 'expired')),
  CONSTRAINT project_invitations_revision CHECK (revision > 0),
  CONSTRAINT project_invitations_timestamps
    CHECK (
      created_at = date_trunc('second', created_at)
      AND expires_at = created_at + interval '24 hours'
      AND secret_replay_expires_at = created_at + interval '30 days'
      AND (
        (state IN ('active', 'redeeming') AND terminal_at IS NULL)
        OR (state IN ('redeemed', 'revoked', 'expired') AND terminal_at IS NOT NULL)
      )
    )
);

CREATE TABLE claudian_cloud.cloud_project_join_journals (
  project_id varchar(64) NOT NULL,
  operation_id varchar(128) NOT NULL,
  phase text NOT NULL,
  principal_id varchar(128) NOT NULL,
  principal_sha256 char(64) NOT NULL,
  idempotency_key varchar(128) NOT NULL,
  request_fingerprint char(64) NOT NULL,
  invitation_id varchar(128) NOT NULL,
  invitation_revision bigint NOT NULL,
  secret_sha256 char(64) NOT NULL,
  member_id varchar(64) NOT NULL,
  display_name varchar(128) NOT NULL,
  personal_ref varchar(255) NOT NULL,
  expected_main_oid varchar(64) NOT NULL,
  manager_set_generation bigint NOT NULL,
  storage_node_id varchar(64) NOT NULL,
  repository_storage_key varchar(128) NOT NULL,
  placement_generation bigint NOT NULL,
  response_json text,
  prepared_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  PRIMARY KEY (project_id, operation_id),
  CONSTRAINT cloud_project_join_journals_project
    FOREIGN KEY (project_id)
    REFERENCES claudian_cloud.projects(project_id),
  CONSTRAINT cloud_project_join_journals_invitation
    FOREIGN KEY (project_id, invitation_id)
    REFERENCES claudian_cloud.project_invitations(project_id, invitation_id),
  CONSTRAINT cloud_project_join_journals_identity
    UNIQUE (project_id, principal_id, idempotency_key),
  CONSTRAINT cloud_project_join_journals_operation
    CHECK (operation_id ~ '^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$'),
  CONSTRAINT cloud_project_join_journals_principal
    CHECK (
      principal_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
      AND principal_sha256 ~ '^[0-9a-f]{64}$'
    ),
  CONSTRAINT cloud_project_join_journals_key
    CHECK (idempotency_key ~ '^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$'),
  CONSTRAINT cloud_project_join_journals_digests
    CHECK (
      request_fingerprint ~ '^[0-9a-f]{64}$'
      AND secret_sha256 ~ '^[0-9a-f]{64}$'
    ),
  CONSTRAINT cloud_project_join_journals_phase
    CHECK (phase IN (
      'prepared',
      'membership-pending',
      'personal-ref-created',
      'membership-active',
      'completed'
    )),
  CONSTRAINT cloud_project_join_journals_member
    CHECK (
      member_id ~ '^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$'
      AND personal_ref = 'refs/heads/members/' || member_id
      AND octet_length(display_name) BETWEEN 1 AND 128
    ),
  CONSTRAINT cloud_project_join_journals_expected_state
    CHECK (
      invitation_revision > 0
      AND expected_main_oid ~ '^(?:[0-9a-f]{40}|[0-9a-f]{64})$'
      AND manager_set_generation BETWEEN 1 AND 9007199254740991
      AND placement_generation BETWEEN 1 AND 9007199254740991
    ),
  CONSTRAINT cloud_project_join_journals_placement
    CHECK (
      storage_node_id ~ '^[a-z0-9]([a-z0-9._-]{0,62}[a-z0-9])?$'
      AND repository_storage_key ~ '^[a-z0-9][a-z0-9_-]{0,127}$'
    ),
  CONSTRAINT cloud_project_join_journals_response
    CHECK (
      (phase IN ('prepared', 'membership-pending', 'personal-ref-created')
        AND response_json IS NULL)
      OR (phase IN ('membership-active', 'completed')
        AND octet_length(response_json) BETWEEN 2 AND 65536)
    ),
  CONSTRAINT cloud_project_join_journals_timestamps
    CHECK (prepared_at = date_trunc('second', prepared_at) AND updated_at >= prepared_at)
);

CREATE TABLE claudian_cloud.protected_invitation_envelopes (
  project_id varchar(64) NOT NULL,
  invitation_id varchar(128) NOT NULL,
  encryption_algorithm text NOT NULL,
  key_id varchar(128) NOT NULL,
  key_version bigint NOT NULL,
  nonce varchar(64) NOT NULL,
  ciphertext varchar(512) NOT NULL,
  tag varchar(64) NOT NULL,
  associated_data_sha256 char(64) NOT NULL,
  created_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  PRIMARY KEY (project_id, invitation_id),
  CONSTRAINT protected_invitation_envelopes_invitation
    FOREIGN KEY (project_id, invitation_id)
    REFERENCES claudian_cloud.project_invitations(project_id, invitation_id),
  CONSTRAINT protected_invitation_envelopes_algorithm
    CHECK (encryption_algorithm = 'xchacha20-poly1305'),
  CONSTRAINT protected_invitation_envelopes_key
    CHECK (
      key_id ~ '^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$'
      AND key_version BETWEEN 1 AND 9007199254740991
    ),
  CONSTRAINT protected_invitation_envelopes_encoding
    CHECK (
      nonce ~ '^[A-Za-z0-9_-]{32}$'
      AND ciphertext ~ '^[A-Za-z0-9_-]+$'
      AND tag ~ '^[A-Za-z0-9_-]{22}$'
      AND associated_data_sha256 ~ '^[0-9a-f]{64}$'
    ),
  CONSTRAINT protected_invitation_envelopes_timestamps
    CHECK (expires_at > created_at)
);

CREATE TABLE claudian_cloud.secret_replay_tombstones (
  project_id varchar(64) NOT NULL,
  actor_member_id varchar(64) NOT NULL,
  operation text NOT NULL,
  idempotency_key varchar(128) NOT NULL,
  request_fingerprint char(64) NOT NULL,
  expired_at timestamptz NOT NULL,
  PRIMARY KEY (project_id, actor_member_id, operation, idempotency_key),
  CONSTRAINT secret_replay_tombstones_actor
    FOREIGN KEY (project_id, actor_member_id)
    REFERENCES claudian_cloud.project_memberships(project_id, member_id),
  CONSTRAINT secret_replay_tombstones_operation
    CHECK (operation IN ('createProjectInvitation', 'reissueTransferredMembershipClaim')),
  CONSTRAINT secret_replay_tombstones_key
    CHECK (idempotency_key ~ '^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$'),
  CONSTRAINT secret_replay_tombstones_fingerprint
    CHECK (request_fingerprint ~ '^[0-9a-f]{64}$')
);

CREATE TABLE claudian_cloud.project_membership_idempotency_tombstones (
  project_id varchar(64) NOT NULL,
  actor_member_id varchar(64) NOT NULL,
  operation text NOT NULL,
  idempotency_key varchar(128) NOT NULL,
  request_fingerprint char(64) NOT NULL,
  compacted_at timestamptz NOT NULL,
  PRIMARY KEY (project_id, actor_member_id, operation, idempotency_key),
  CONSTRAINT project_membership_idempotency_tombstones_actor
    FOREIGN KEY (project_id, actor_member_id)
    REFERENCES claudian_cloud.project_memberships(project_id, member_id),
  CONSTRAINT project_membership_idempotency_tombstones_operation
    CHECK (operation IN (
      'createManagerResponsibilityOffer',
      'acknowledgeManagerResponsibility',
      'declineManagerResponsibility',
      'cancelManagerResponsibilityOffer',
      'promoteManager'
    )),
  CONSTRAINT project_membership_idempotency_tombstones_key
    CHECK (idempotency_key ~ '^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$'),
  CONSTRAINT project_membership_idempotency_tombstones_fingerprint
    CHECK (request_fingerprint ~ '^[0-9a-f]{64}$')
);

CREATE TABLE claudian_cloud.manager_responsibility_offers (
  project_id varchar(64) NOT NULL,
  offer_id varchar(128) NOT NULL,
  source_manager_member_id varchar(64) NOT NULL,
  target_member_id varchar(64) NOT NULL,
  purpose text NOT NULL,
  state text NOT NULL,
  revision bigint NOT NULL,
  manager_set_generation_at_offer bigint NOT NULL,
  target_membership_revision_at_offer bigint NOT NULL,
  idempotency_key varchar(128) NOT NULL,
  request_fingerprint char(64) NOT NULL,
  offered_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  acknowledged_at timestamptz,
  terminal_at timestamptz,
  PRIMARY KEY (project_id, offer_id),
  CONSTRAINT manager_responsibility_offers_source
    FOREIGN KEY (project_id, source_manager_member_id)
    REFERENCES claudian_cloud.project_memberships(project_id, member_id),
  CONSTRAINT manager_responsibility_offers_target
    FOREIGN KEY (project_id, target_member_id)
    REFERENCES claudian_cloud.project_memberships(project_id, member_id),
  CONSTRAINT manager_responsibility_offers_identity
    UNIQUE (project_id, source_manager_member_id, idempotency_key),
  CONSTRAINT manager_responsibility_offers_id_format
    CHECK (offer_id ~ '^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$'),
  CONSTRAINT manager_responsibility_offers_key_format
    CHECK (idempotency_key ~ '^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$'),
  CONSTRAINT manager_responsibility_offers_fingerprint
    CHECK (request_fingerprint ~ '^[0-9a-f]{64}$'),
  CONSTRAINT manager_responsibility_offers_purpose
    CHECK (purpose IN ('manager-promotion', 'manager-leave')),
  CONSTRAINT manager_responsibility_offers_state
    CHECK (state IN (
      'offered', 'acknowledged', 'declined', 'cancelled', 'consumed', 'expired'
    )),
  CONSTRAINT manager_responsibility_offers_revision
    CHECK (
      revision > 0
      AND manager_set_generation_at_offer BETWEEN 1 AND 9007199254740991
      AND target_membership_revision_at_offer BETWEEN 1 AND 9007199254740991
    ),
  CONSTRAINT manager_responsibility_offers_members
    CHECK (source_manager_member_id <> target_member_id),
  CONSTRAINT manager_responsibility_offers_timestamps
    CHECK (
      offered_at = date_trunc('second', offered_at)
      AND expires_at = offered_at + interval '24 hours'
      AND (
        (state = 'offered' AND acknowledged_at IS NULL AND terminal_at IS NULL)
        OR (
          state = 'acknowledged'
          AND acknowledged_at >= offered_at
          AND terminal_at IS NULL
        )
        OR (
          state IN ('declined', 'cancelled', 'consumed', 'expired')
          AND terminal_at >= offered_at
        )
      )
    )
);

CREATE TABLE claudian_cloud.project_member_removal_journals (
  project_id varchar(64) NOT NULL,
  operation_id varchar(128) NOT NULL,
  actor_member_id varchar(64) NOT NULL,
  target_member_id varchar(64) NOT NULL,
  idempotency_key varchar(128) NOT NULL,
  request_fingerprint char(64) NOT NULL,
  expected_target_membership_revision bigint NOT NULL,
  expected_manager_set_generation bigint NOT NULL,
  expected_personal_ref_oid varchar(64) NOT NULL,
  personal_ref varchar(255) NOT NULL,
  storage_node_id varchar(64) NOT NULL,
  repository_storage_key varchar(128) NOT NULL,
  placement_generation bigint NOT NULL,
  phase text NOT NULL,
  response_json text,
  prepared_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  PRIMARY KEY (project_id, operation_id),
  CONSTRAINT project_member_removal_journals_lifecycle
    FOREIGN KEY (project_id, operation_id)
    REFERENCES claudian_cloud.project_lifecycle_journals(project_id, operation_id),
  CONSTRAINT project_member_removal_journals_actor
    FOREIGN KEY (project_id, actor_member_id)
    REFERENCES claudian_cloud.project_memberships(project_id, member_id),
  CONSTRAINT project_member_removal_journals_target
    FOREIGN KEY (project_id, target_member_id)
    REFERENCES claudian_cloud.project_memberships(project_id, member_id),
  CONSTRAINT project_member_removal_journals_identity
    UNIQUE (project_id, actor_member_id, idempotency_key),
  CONSTRAINT project_member_removal_journals_members
    CHECK (actor_member_id <> target_member_id),
  CONSTRAINT project_member_removal_journals_key
    CHECK (idempotency_key ~ '^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$'),
  CONSTRAINT project_member_removal_journals_fingerprint
    CHECK (request_fingerprint ~ '^[0-9a-f]{64}$'),
  CONSTRAINT project_member_removal_journals_expected_state
    CHECK (
      expected_target_membership_revision BETWEEN 1 AND 9007199254740991
      AND expected_manager_set_generation BETWEEN 1 AND 9007199254740991
      AND expected_personal_ref_oid ~ '^(?:[0-9a-f]{40}|[0-9a-f]{64})$'
      AND placement_generation BETWEEN 1 AND 9007199254740991
    ),
  CONSTRAINT project_member_removal_journals_ref
    CHECK (personal_ref = 'refs/heads/members/' || target_member_id),
  CONSTRAINT project_member_removal_journals_placement
    CHECK (
      storage_node_id ~ '^[a-z0-9]([a-z0-9._-]{0,62}[a-z0-9])?$'
      AND repository_storage_key ~ '^[a-z0-9][a-z0-9_-]{0,127}$'
    ),
  CONSTRAINT project_member_removal_journals_phase
    CHECK (phase IN (
      'prepared', 'membership-revoked', 'personal-ref-removed', 'completed'
    )),
  CONSTRAINT project_member_removal_journals_response
    CHECK (
      (phase = 'prepared' AND response_json IS NULL)
      OR (phase IN ('membership-revoked', 'personal-ref-removed', 'completed')
        AND octet_length(response_json) BETWEEN 2 AND 65536)
    ),
  CONSTRAINT project_member_removal_journals_timestamps
    CHECK (prepared_at = date_trunc('second', prepared_at) AND updated_at >= prepared_at)
);

CREATE TABLE claudian_cloud.transferred_membership_claim_overrides (
  project_id varchar(64) NOT NULL,
  transfer_id varchar(128) NOT NULL,
  member_id varchar(64) NOT NULL,
  claim_generation bigint NOT NULL,
  superseded_claim_sha256 char(64) NOT NULL,
  claim_sha256 char(64) NOT NULL,
  manager_member_id varchar(64) NOT NULL,
  idempotency_key varchar(128) NOT NULL,
  request_fingerprint char(64) NOT NULL,
  state text NOT NULL,
  target_principal_id varchar(128),
  operation_intent_id varchar(128),
  redemption_receipt_id varchar(128),
  created_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  secret_replay_expires_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  PRIMARY KEY (project_id, transfer_id, member_id, claim_generation),
  CONSTRAINT transferred_membership_claim_overrides_original
    FOREIGN KEY (project_id, transfer_id)
    REFERENCES claudian_cloud.project_lifecycle_journals(project_id, operation_id),
  CONSTRAINT transferred_membership_claim_overrides_member
    FOREIGN KEY (project_id, member_id)
    REFERENCES claudian_cloud.project_memberships(project_id, member_id),
  CONSTRAINT transferred_membership_claim_overrides_manager
    FOREIGN KEY (project_id, manager_member_id)
    REFERENCES claudian_cloud.project_memberships(project_id, member_id),
  CONSTRAINT transferred_membership_claim_overrides_identity
    UNIQUE (project_id, manager_member_id, idempotency_key),
  CONSTRAINT transferred_membership_claim_overrides_digest_identity
    UNIQUE (project_id, transfer_id, claim_sha256),
  CONSTRAINT transferred_membership_claim_overrides_generation
    CHECK (claim_generation BETWEEN 1 AND 9007199254740991),
  CONSTRAINT transferred_membership_claim_overrides_key
    CHECK (idempotency_key ~ '^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$'),
  CONSTRAINT transferred_membership_claim_overrides_digests
    CHECK (
      superseded_claim_sha256 ~ '^[0-9a-f]{64}$'
      AND claim_sha256 ~ '^[0-9a-f]{64}$'
      AND request_fingerprint ~ '^[0-9a-f]{64}$'
      AND superseded_claim_sha256 <> claim_sha256
    ),
  CONSTRAINT transferred_membership_claim_overrides_state
    CHECK (state IN ('active', 'redeemed', 'revoked', 'superseded', 'expired')),
  CONSTRAINT transferred_membership_claim_overrides_binding
    CHECK (
      (
        state = 'redeemed'
        AND target_principal_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
        AND operation_intent_id ~ '^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$'
        AND redemption_receipt_id ~ '^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$'
      )
      OR (
        state <> 'redeemed'
        AND target_principal_id IS NULL
        AND operation_intent_id IS NULL
        AND redemption_receipt_id IS NULL
      )
    ),
  CONSTRAINT transferred_membership_claim_overrides_timestamps
    CHECK (
      created_at = date_trunc('second', created_at)
      AND expires_at = created_at + interval '30 days'
      AND secret_replay_expires_at = created_at + interval '30 days'
      AND updated_at >= created_at
    )
);

CREATE TABLE claudian_cloud.protected_claim_override_envelopes (
  project_id varchar(64) NOT NULL,
  transfer_id varchar(128) NOT NULL,
  member_id varchar(64) NOT NULL,
  claim_generation bigint NOT NULL,
  encryption_algorithm text NOT NULL,
  key_id varchar(128) NOT NULL,
  key_version bigint NOT NULL,
  nonce varchar(64) NOT NULL,
  ciphertext varchar(512) NOT NULL,
  tag varchar(64) NOT NULL,
  associated_data_sha256 char(64) NOT NULL,
  created_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  PRIMARY KEY (project_id, transfer_id, member_id, claim_generation),
  CONSTRAINT protected_claim_override_envelopes_override
    FOREIGN KEY (project_id, transfer_id, member_id, claim_generation)
    REFERENCES claudian_cloud.transferred_membership_claim_overrides(
      project_id, transfer_id, member_id, claim_generation
    ),
  CONSTRAINT protected_claim_override_envelopes_algorithm
    CHECK (encryption_algorithm = 'xchacha20-poly1305'),
  CONSTRAINT protected_claim_override_envelopes_key
    CHECK (
      key_id ~ '^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$'
      AND key_version BETWEEN 1 AND 9007199254740991
    ),
  CONSTRAINT protected_claim_override_envelopes_encoding
    CHECK (
      nonce ~ '^[A-Za-z0-9_-]{32}$'
      AND ciphertext ~ '^[A-Za-z0-9_-]+$'
      AND tag ~ '^[A-Za-z0-9_-]{22}$'
      AND associated_data_sha256 ~ '^[0-9a-f]{64}$'
    ),
  CONSTRAINT protected_claim_override_envelopes_timestamps
    CHECK (expires_at > created_at)
);

-- Indexes.

CREATE INDEX project_memberships_by_status
  ON claudian_cloud.project_memberships(project_id, status, member_id);

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

CREATE INDEX development_bootstrap_expiry_candidates_page
  ON claudian_cloud.development_bootstrap_expiry_candidates (
    expires_at,
    project_id,
    attempt_id
  );

CREATE UNIQUE INDEX development_bootstrap_one_nonterminal_settlement_per_project
  ON claudian_cloud.development_bootstrap_settlements (project_id)
  WHERE (
    (kind = 'activation' AND activation_phase <> 'completed')
    OR (kind = 'cancellation' AND cancellation_phase = 'cancel-intent')
  );

CREATE INDEX recovery_candidates_schedule_page
  ON claudian_cloud.recovery_candidates (
    scheduled_at,
    kind,
    project_id,
    operation_id
  );

CREATE INDEX project_events_by_retention
  ON claudian_cloud.project_events(project_id, occurred_at, sequence);

CREATE UNIQUE INDEX change_requests_one_open_per_member
  ON claudian_cloud.change_requests(project_id, member_id)
  WHERE status = 'open';

CREATE INDEX change_requests_open_snapshot
  ON claudian_cloud.change_requests(project_id, request_id)
  WHERE status = 'open';

CREATE INDEX request_comments_by_request
  ON claudian_cloud.request_comments(
    project_id,
    request_id,
    created_at,
    comment_id
  );

CREATE INDEX tickets_by_status_updated
  ON claudian_cloud.tickets(
    project_id,
    status,
    updated_at DESC,
    ticket_number DESC
  );

CREATE INDEX ticket_comments_by_ticket
  ON claudian_cloud.ticket_comments(
    project_id,
    ticket_id,
    created_at,
    comment_id
  );

CREATE INDEX request_ticket_relations_by_request
  ON claudian_cloud.request_ticket_relations(
    project_id,
    request_id,
    state,
    relation_id
  );

CREATE INDEX request_ticket_relations_by_ticket
  ON claudian_cloud.request_ticket_relations(
    project_id,
    ticket_id,
    state,
    accepted_at,
    relation_id
  );

CREATE INDEX ticket_mentions_by_member
  ON claudian_cloud.ticket_mentions(
    project_id,
    mentioned_member_id,
    created_at,
    ticket_id
  );

CREATE UNIQUE INDEX accept_journals_one_nonterminal
  ON claudian_cloud.accept_journals(project_id)
  WHERE phase <> 'completed';

CREATE UNIQUE INDEX project_lifecycle_one_nonterminal
  ON claudian_cloud.project_lifecycle_journals(project_id)
  WHERE state IN ('active', 'recovery-required');

CREATE UNIQUE INDEX project_lifecycle_idempotency_identity
  ON claudian_cloud.project_lifecycle_journals(
    project_id,
    actor_member_id,
    kind,
    idempotency_key
  ) NULLS NOT DISTINCT;

CREATE UNIQUE INDEX project_principal_bindings_active_member
  ON claudian_cloud.project_principal_bindings(project_id, member_id)
  WHERE state = 'active';

CREATE UNIQUE INDEX leave_former_principal_replays_exact_intent
  ON claudian_cloud.leave_former_principal_replays(
    project_id,
    principal_sha256,
    member_id,
    intent_id
  );

CREATE INDEX project_deletion_by_project
  ON claudian_cloud.project_deletion_intents(project_id);

CREATE UNIQUE INDEX cloud_project_join_journals_nonterminal
  ON claudian_cloud.cloud_project_join_journals(project_id)
  WHERE phase <> 'completed';

CREATE INDEX project_invitations_current
  ON claudian_cloud.project_invitations(project_id, state, invitation_id);

CREATE UNIQUE INDEX manager_responsibility_offers_current_source
  ON claudian_cloud.manager_responsibility_offers(
    project_id, source_manager_member_id
  )
  WHERE state IN ('offered', 'acknowledged');

CREATE UNIQUE INDEX manager_responsibility_offers_current_target
  ON claudian_cloud.manager_responsibility_offers(
    project_id, target_member_id
  )
  WHERE state IN ('offered', 'acknowledged');

CREATE INDEX manager_responsibility_offers_current
  ON claudian_cloud.manager_responsibility_offers(project_id, state, offer_id);

CREATE UNIQUE INDEX transferred_membership_claim_overrides_effective
  ON claudian_cloud.transferred_membership_claim_overrides(
    project_id, transfer_id, member_id
  )
  WHERE state = 'active';

-- Scoped persistence functions.

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

CREATE FUNCTION claudian_cloud.remove_project_coordination_content(
  requested_project_id varchar,
  requested_operation_id varchar,
  requested_terminal_operation_kind text,
  requested_terminal_operation_id varchar
)
RETURNS boolean
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF requested_project_id IS DISTINCT FROM
      nullif(current_setting('claudian_cloud.project_id', true), '') THEN
    RAISE EXCEPTION 'project scope mismatch' USING ERRCODE = '42501';
  END IF;
  IF NOT EXISTS (
    SELECT 1
      FROM claudian_cloud.project_deletion_intents AS intent
      JOIN claudian_cloud.project_lifecycle_journals AS journal
        ON journal.project_id = intent.project_id
       AND journal.operation_id = intent.operation_id
      JOIN claudian_cloud.project_tombstones AS tombstone
        ON tombstone.project_id = intent.project_id
       AND tombstone.terminal_operation_kind = intent.terminal_operation_kind
       AND tombstone.terminal_operation_id = intent.terminal_operation_id
     WHERE intent.project_id = requested_project_id
       AND intent.operation_id = requested_operation_id
       AND intent.terminal_operation_kind = requested_terminal_operation_kind
       AND intent.terminal_operation_id = requested_terminal_operation_id
       AND journal.kind = 'delete'
       AND journal.state = 'active'
       AND journal.phase = 'repository-removed'
  ) THEN
    RETURN false;
  END IF;

  DELETE FROM claudian_cloud.leave_project_request_facts
   WHERE project_id = requested_project_id;
  DELETE FROM claudian_cloud.protected_claim_override_envelopes
   WHERE project_id = requested_project_id;
  DELETE FROM claudian_cloud.transferred_membership_claim_overrides
   WHERE project_id = requested_project_id;
  DELETE FROM claudian_cloud.project_member_removal_journals
   WHERE project_id = requested_project_id;
  DELETE FROM claudian_cloud.manager_responsibility_offers
   WHERE project_id = requested_project_id;
  DELETE FROM claudian_cloud.project_membership_idempotency_tombstones
   WHERE project_id = requested_project_id;
  DELETE FROM claudian_cloud.secret_replay_tombstones
   WHERE project_id = requested_project_id;
  DELETE FROM claudian_cloud.protected_invitation_envelopes
   WHERE project_id = requested_project_id;
  DELETE FROM claudian_cloud.cloud_project_join_journals
   WHERE project_id = requested_project_id;
  DELETE FROM claudian_cloud.project_invitations
   WHERE project_id = requested_project_id;
  DELETE FROM claudian_cloud.cloud_project_creation_journals
   WHERE project_id = requested_project_id;
  DELETE FROM claudian_cloud.leave_former_principal_replays
   WHERE project_id = requested_project_id;
  DELETE FROM claudian_cloud.project_principal_bindings
   WHERE project_id = requested_project_id;
  DELETE FROM claudian_cloud.transfer_redemption_receipts
   WHERE project_id = requested_project_id
     AND acknowledged_at IS NULL;
  DELETE FROM claudian_cloud.transfer_claim_batch_receipts
   WHERE project_id = requested_project_id;
  DELETE FROM claudian_cloud.transferred_membership_claims
   WHERE project_id = requested_project_id;
  DELETE FROM claudian_cloud.authority_transfer_recovery
   WHERE project_id = requested_project_id;
  DELETE FROM claudian_cloud.project_backup_catalog
   WHERE project_id = requested_project_id;
  DELETE FROM claudian_cloud.transfer_receipt_keys AS receipt_key
   WHERE receipt_key.project_id = requested_project_id
     AND NOT EXISTS (
       SELECT 1
         FROM claudian_cloud.source_protected_claim_envelopes AS envelope
        WHERE envelope.project_id = receipt_key.project_id
          AND envelope.transfer_id = receipt_key.transfer_id
          AND envelope.receipt_key_id = receipt_key.receipt_key_id
     )
     AND NOT EXISTS (
       SELECT 1
         FROM claudian_cloud.transfer_redemption_receipts AS receipt
        WHERE receipt.project_id = receipt_key.project_id
          AND receipt.transfer_id = receipt_key.transfer_id
          AND receipt.receipt_key_id = receipt_key.receipt_key_id
     );
  DELETE FROM claudian_cloud.project_terminal_responders AS responder
   WHERE responder.project_id = requested_project_id
     AND NOT EXISTS (
       SELECT 1 FROM claudian_cloud.project_tombstones AS tombstone
        WHERE tombstone.project_id = responder.project_id
          AND tombstone.terminal_operation_id = responder.operation_id
          AND tombstone.terminal_operation_kind = responder.operation_kind
     );
  DELETE FROM claudian_cloud.recovery_candidates
   WHERE project_id = requested_project_id
     AND (kind <> 'delete' OR operation_id <> requested_operation_id);
  DELETE FROM claudian_cloud.project_lifecycle_journals AS journal
   WHERE journal.project_id = requested_project_id
     AND journal.operation_id <> requested_operation_id
     AND journal.operation_id <> requested_terminal_operation_id
     AND NOT EXISTS (
       SELECT 1 FROM claudian_cloud.project_tombstones AS tombstone
        WHERE tombstone.project_id = journal.project_id
          AND (tombstone.terminal_operation_id = journal.operation_id
                    OR (journal.kind = 'delete'
                      AND journal.expected_authority_generation = tombstone.authority_generation
                      AND journal.request_fingerprint = tombstone.result_sha256))
     )
     AND NOT EXISTS (
       SELECT 1 FROM claudian_cloud.project_deletion_intents AS intent
        WHERE intent.project_id = journal.project_id
          AND intent.operation_id = journal.operation_id
     )
     AND NOT EXISTS (
       SELECT 1
         FROM claudian_cloud.source_protected_claim_envelopes AS envelope
        WHERE envelope.project_id = journal.project_id
          AND envelope.transfer_id = journal.operation_id
     );
  DELETE FROM claudian_cloud.development_bootstrap_settlements
   WHERE project_id = requested_project_id;
  DELETE FROM claudian_cloud.development_bootstrap_attempts
   WHERE project_id = requested_project_id;
  DELETE FROM claudian_cloud.development_actor_mappings
   WHERE project_id = requested_project_id;
  DELETE FROM claudian_cloud.accept_journal_relations
   WHERE project_id = requested_project_id;
  DELETE FROM claudian_cloud.accept_journals
   WHERE project_id = requested_project_id;
  DELETE FROM claudian_cloud.request_ticket_relations
   WHERE project_id = requested_project_id;
  DELETE FROM claudian_cloud.ticket_mentions
   WHERE project_id = requested_project_id;
  DELETE FROM claudian_cloud.ticket_comments
   WHERE project_id = requested_project_id;
  DELETE FROM claudian_cloud.request_comments
   WHERE project_id = requested_project_id;
  DELETE FROM claudian_cloud.tickets
   WHERE project_id = requested_project_id;
  DELETE FROM claudian_cloud.change_requests
   WHERE project_id = requested_project_id;
  DELETE FROM claudian_cloud.idempotency_results
   WHERE project_id = requested_project_id;
  DELETE FROM claudian_cloud.project_events
   WHERE project_id = requested_project_id;
  DELETE FROM claudian_cloud.project_event_sequences
   WHERE project_id = requested_project_id;
  DELETE FROM claudian_cloud.active_repository_placement_catalog
   WHERE project_id = requested_project_id;
  DELETE FROM claudian_cloud.repository_placements
   WHERE project_id = requested_project_id;
  DELETE FROM claudian_cloud.project_memberships
   WHERE project_id = requested_project_id;
  DELETE FROM claudian_cloud.projects
   WHERE project_id = requested_project_id;
  RETURN true;
END
$$;

CREATE FUNCTION claudian_cloud.register_project_terminal_continuity()
RETURNS trigger
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  INSERT INTO claudian_cloud.project_terminal_continuity_catalog (
    project_id,
    retired_at
  ) VALUES (
    NEW.project_id,
    NEW.retired_at
  )
  ON CONFLICT (project_id) DO NOTHING;
  RETURN NEW;
END
$$;

-- Catalog triggers.

CREATE TRIGGER project_tombstones_register_terminal_continuity
AFTER INSERT ON claudian_cloud.project_tombstones
FOR EACH ROW
EXECUTE FUNCTION claudian_cloud.register_project_terminal_continuity();

-- Project row security.

ALTER TABLE claudian_cloud.projects ENABLE ROW LEVEL SECURITY;

ALTER TABLE claudian_cloud.projects FORCE ROW LEVEL SECURITY;

ALTER TABLE claudian_cloud.project_memberships ENABLE ROW LEVEL SECURITY;

ALTER TABLE claudian_cloud.project_memberships FORCE ROW LEVEL SECURITY;

ALTER TABLE claudian_cloud.repository_placements ENABLE ROW LEVEL SECURITY;

ALTER TABLE claudian_cloud.repository_placements FORCE ROW LEVEL SECURITY;

CREATE POLICY projects_project_scope ON claudian_cloud.projects
  USING (
    project_id = nullif(current_setting('claudian_cloud.project_id', true), '')
  )
  WITH CHECK (
    project_id = nullif(current_setting('claudian_cloud.project_id', true), '')
  );

CREATE POLICY project_memberships_project_scope
  ON claudian_cloud.project_memberships
  USING (
    project_id = nullif(current_setting('claudian_cloud.project_id', true), '')
  )
  WITH CHECK (
    project_id = nullif(current_setting('claudian_cloud.project_id', true), '')
  );

CREATE POLICY repository_placements_project_scope
  ON claudian_cloud.repository_placements
  USING (
    project_id = nullif(current_setting('claudian_cloud.project_id', true), '')
  )
  WITH CHECK (
    project_id = nullif(current_setting('claudian_cloud.project_id', true), '')
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

ALTER TABLE claudian_cloud.project_event_sequences ENABLE ROW LEVEL SECURITY;

ALTER TABLE claudian_cloud.project_event_sequences FORCE ROW LEVEL SECURITY;

ALTER TABLE claudian_cloud.project_events ENABLE ROW LEVEL SECURITY;

ALTER TABLE claudian_cloud.project_events FORCE ROW LEVEL SECURITY;

CREATE POLICY project_event_sequences_project_scope
  ON claudian_cloud.project_event_sequences
  USING (
    project_id = nullif(current_setting('claudian_cloud.project_id', true), '')
  )
  WITH CHECK (
    project_id = nullif(current_setting('claudian_cloud.project_id', true), '')
  );

CREATE POLICY project_events_project_scope
  ON claudian_cloud.project_events
  USING (
    project_id = nullif(current_setting('claudian_cloud.project_id', true), '')
  )
  WITH CHECK (
    project_id = nullif(current_setting('claudian_cloud.project_id', true), '')
  );

ALTER TABLE claudian_cloud.change_requests ENABLE ROW LEVEL SECURITY;

ALTER TABLE claudian_cloud.change_requests FORCE ROW LEVEL SECURITY;

ALTER TABLE claudian_cloud.request_comments ENABLE ROW LEVEL SECURITY;

ALTER TABLE claudian_cloud.request_comments FORCE ROW LEVEL SECURITY;

ALTER TABLE claudian_cloud.tickets ENABLE ROW LEVEL SECURITY;

ALTER TABLE claudian_cloud.tickets FORCE ROW LEVEL SECURITY;

ALTER TABLE claudian_cloud.ticket_comments ENABLE ROW LEVEL SECURITY;

ALTER TABLE claudian_cloud.ticket_comments FORCE ROW LEVEL SECURITY;

ALTER TABLE claudian_cloud.request_ticket_relations ENABLE ROW LEVEL SECURITY;

ALTER TABLE claudian_cloud.request_ticket_relations FORCE ROW LEVEL SECURITY;

ALTER TABLE claudian_cloud.ticket_mentions ENABLE ROW LEVEL SECURITY;

ALTER TABLE claudian_cloud.ticket_mentions FORCE ROW LEVEL SECURITY;

ALTER TABLE claudian_cloud.idempotency_results ENABLE ROW LEVEL SECURITY;

ALTER TABLE claudian_cloud.idempotency_results FORCE ROW LEVEL SECURITY;

CREATE POLICY change_requests_project_scope
  ON claudian_cloud.change_requests
  USING (
    project_id = nullif(current_setting('claudian_cloud.project_id', true), '')
  )
  WITH CHECK (
    project_id = nullif(current_setting('claudian_cloud.project_id', true), '')
  );

CREATE POLICY request_comments_project_scope
  ON claudian_cloud.request_comments
  USING (
    project_id = nullif(current_setting('claudian_cloud.project_id', true), '')
  )
  WITH CHECK (
    project_id = nullif(current_setting('claudian_cloud.project_id', true), '')
  );

CREATE POLICY tickets_project_scope
  ON claudian_cloud.tickets
  USING (
    project_id = nullif(current_setting('claudian_cloud.project_id', true), '')
  )
  WITH CHECK (
    project_id = nullif(current_setting('claudian_cloud.project_id', true), '')
  );

CREATE POLICY ticket_comments_project_scope
  ON claudian_cloud.ticket_comments
  USING (
    project_id = nullif(current_setting('claudian_cloud.project_id', true), '')
  )
  WITH CHECK (
    project_id = nullif(current_setting('claudian_cloud.project_id', true), '')
  );

CREATE POLICY request_ticket_relations_project_scope
  ON claudian_cloud.request_ticket_relations
  USING (
    project_id = nullif(current_setting('claudian_cloud.project_id', true), '')
  )
  WITH CHECK (
    project_id = nullif(current_setting('claudian_cloud.project_id', true), '')
  );

CREATE POLICY ticket_mentions_project_scope
  ON claudian_cloud.ticket_mentions
  USING (
    project_id = nullif(current_setting('claudian_cloud.project_id', true), '')
  )
  WITH CHECK (
    project_id = nullif(current_setting('claudian_cloud.project_id', true), '')
  );

CREATE POLICY idempotency_results_project_scope
  ON claudian_cloud.idempotency_results
  USING (
    project_id = nullif(current_setting('claudian_cloud.project_id', true), '')
  )
  WITH CHECK (
    project_id = nullif(current_setting('claudian_cloud.project_id', true), '')
  );

ALTER TABLE claudian_cloud.accept_journals ENABLE ROW LEVEL SECURITY;

ALTER TABLE claudian_cloud.accept_journals FORCE ROW LEVEL SECURITY;

ALTER TABLE claudian_cloud.accept_journal_relations ENABLE ROW LEVEL SECURITY;

ALTER TABLE claudian_cloud.accept_journal_relations FORCE ROW LEVEL SECURITY;

CREATE POLICY accept_journals_project_scope
  ON claudian_cloud.accept_journals
  USING (
    project_id = nullif(current_setting('claudian_cloud.project_id', true), '')
  )
  WITH CHECK (
    project_id = nullif(current_setting('claudian_cloud.project_id', true), '')
  );

CREATE POLICY accept_journal_relations_project_scope
  ON claudian_cloud.accept_journal_relations
  USING (
    project_id = nullif(current_setting('claudian_cloud.project_id', true), '')
  )
  WITH CHECK (
    project_id = nullif(current_setting('claudian_cloud.project_id', true), '')
  );

ALTER TABLE claudian_cloud.project_lifecycle_journals ENABLE ROW LEVEL SECURITY;

ALTER TABLE claudian_cloud.project_lifecycle_journals FORCE ROW LEVEL SECURITY;

ALTER TABLE claudian_cloud.project_principal_bindings ENABLE ROW LEVEL SECURITY;

ALTER TABLE claudian_cloud.project_principal_bindings FORCE ROW LEVEL SECURITY;

ALTER TABLE claudian_cloud.authority_transfer_recovery ENABLE ROW LEVEL SECURITY;

ALTER TABLE claudian_cloud.authority_transfer_recovery FORCE ROW LEVEL SECURITY;

ALTER TABLE claudian_cloud.transferred_membership_claims ENABLE ROW LEVEL SECURITY;

ALTER TABLE claudian_cloud.transferred_membership_claims FORCE ROW LEVEL SECURITY;

ALTER TABLE claudian_cloud.transfer_receipt_keys ENABLE ROW LEVEL SECURITY;

ALTER TABLE claudian_cloud.transfer_receipt_keys FORCE ROW LEVEL SECURITY;

ALTER TABLE claudian_cloud.source_protected_claim_envelopes ENABLE ROW LEVEL SECURITY;

ALTER TABLE claudian_cloud.source_protected_claim_envelopes FORCE ROW LEVEL SECURITY;

ALTER TABLE claudian_cloud.transfer_claim_batch_receipts ENABLE ROW LEVEL SECURITY;

ALTER TABLE claudian_cloud.transfer_claim_batch_receipts FORCE ROW LEVEL SECURITY;

ALTER TABLE claudian_cloud.transfer_redemption_receipts ENABLE ROW LEVEL SECURITY;

ALTER TABLE claudian_cloud.transfer_redemption_receipts FORCE ROW LEVEL SECURITY;

ALTER TABLE claudian_cloud.project_terminal_responders ENABLE ROW LEVEL SECURITY;

ALTER TABLE claudian_cloud.project_terminal_responders FORCE ROW LEVEL SECURITY;

ALTER TABLE claudian_cloud.project_terminal_acknowledgements ENABLE ROW LEVEL SECURITY;

ALTER TABLE claudian_cloud.project_terminal_acknowledgements FORCE ROW LEVEL SECURITY;

ALTER TABLE claudian_cloud.leave_former_principal_replays ENABLE ROW LEVEL SECURITY;

ALTER TABLE claudian_cloud.leave_former_principal_replays FORCE ROW LEVEL SECURITY;

ALTER TABLE claudian_cloud.project_tombstones ENABLE ROW LEVEL SECURITY;

ALTER TABLE claudian_cloud.project_tombstones FORCE ROW LEVEL SECURITY;

ALTER TABLE claudian_cloud.project_deletion_intents ENABLE ROW LEVEL SECURITY;

ALTER TABLE claudian_cloud.project_deletion_intents FORCE ROW LEVEL SECURITY;

ALTER TABLE claudian_cloud.project_backup_catalog ENABLE ROW LEVEL SECURITY;

ALTER TABLE claudian_cloud.project_backup_catalog FORCE ROW LEVEL SECURITY;

CREATE POLICY project_lifecycle_journals_project_scope
  ON claudian_cloud.project_lifecycle_journals
  USING (project_id = nullif(current_setting('claudian_cloud.project_id', true), ''))
  WITH CHECK (project_id = nullif(current_setting('claudian_cloud.project_id', true), ''));

CREATE POLICY project_principal_bindings_project_scope
  ON claudian_cloud.project_principal_bindings
  USING (project_id = nullif(current_setting('claudian_cloud.project_id', true), ''))
  WITH CHECK (project_id = nullif(current_setting('claudian_cloud.project_id', true), ''));

CREATE POLICY authority_transfer_recovery_project_scope
  ON claudian_cloud.authority_transfer_recovery
  USING (project_id = nullif(current_setting('claudian_cloud.project_id', true), ''))
  WITH CHECK (project_id = nullif(current_setting('claudian_cloud.project_id', true), ''));

CREATE POLICY transferred_membership_claims_project_scope
  ON claudian_cloud.transferred_membership_claims
  USING (project_id = nullif(current_setting('claudian_cloud.project_id', true), ''))
  WITH CHECK (project_id = nullif(current_setting('claudian_cloud.project_id', true), ''));

CREATE POLICY transfer_receipt_keys_project_scope
  ON claudian_cloud.transfer_receipt_keys
  USING (project_id = nullif(current_setting('claudian_cloud.project_id', true), ''))
  WITH CHECK (project_id = nullif(current_setting('claudian_cloud.project_id', true), ''));

CREATE POLICY source_protected_claim_envelopes_project_scope
  ON claudian_cloud.source_protected_claim_envelopes
  USING (project_id = nullif(current_setting('claudian_cloud.project_id', true), ''))
  WITH CHECK (project_id = nullif(current_setting('claudian_cloud.project_id', true), ''));

CREATE POLICY transfer_claim_batch_receipts_project_scope
  ON claudian_cloud.transfer_claim_batch_receipts
  USING (project_id = nullif(current_setting('claudian_cloud.project_id', true), ''))
  WITH CHECK (project_id = nullif(current_setting('claudian_cloud.project_id', true), ''));

CREATE POLICY transfer_redemption_receipts_project_scope
  ON claudian_cloud.transfer_redemption_receipts
  USING (project_id = nullif(current_setting('claudian_cloud.project_id', true), ''))
  WITH CHECK (project_id = nullif(current_setting('claudian_cloud.project_id', true), ''));

CREATE POLICY project_terminal_responders_project_scope
  ON claudian_cloud.project_terminal_responders
  USING (project_id = nullif(current_setting('claudian_cloud.project_id', true), ''))
  WITH CHECK (project_id = nullif(current_setting('claudian_cloud.project_id', true), ''));

CREATE POLICY project_terminal_acknowledgements_project_scope
  ON claudian_cloud.project_terminal_acknowledgements
  USING (project_id = nullif(current_setting('claudian_cloud.project_id', true), ''))
  WITH CHECK (project_id = nullif(current_setting('claudian_cloud.project_id', true), ''));

CREATE POLICY leave_former_principal_replays_project_scope
  ON claudian_cloud.leave_former_principal_replays
  USING (project_id = nullif(current_setting('claudian_cloud.project_id', true), ''))
  WITH CHECK (project_id = nullif(current_setting('claudian_cloud.project_id', true), ''));

CREATE POLICY project_tombstones_project_scope
  ON claudian_cloud.project_tombstones
  USING (project_id = nullif(current_setting('claudian_cloud.project_id', true), ''))
  WITH CHECK (project_id = nullif(current_setting('claudian_cloud.project_id', true), ''));

CREATE POLICY project_deletion_intents_project_scope
  ON claudian_cloud.project_deletion_intents
  USING (project_id = nullif(current_setting('claudian_cloud.project_id', true), ''))
  WITH CHECK (project_id = nullif(current_setting('claudian_cloud.project_id', true), ''));

CREATE POLICY project_backup_catalog_project_scope
  ON claudian_cloud.project_backup_catalog
  USING (project_id = nullif(current_setting('claudian_cloud.project_id', true), ''))
  WITH CHECK (project_id = nullif(current_setting('claudian_cloud.project_id', true), ''));

ALTER TABLE claudian_cloud.leave_project_request_facts
  ENABLE ROW LEVEL SECURITY;

ALTER TABLE claudian_cloud.leave_project_request_facts
  FORCE ROW LEVEL SECURITY;

CREATE POLICY leave_project_request_facts_project_scope
  ON claudian_cloud.leave_project_request_facts
  USING (project_id = nullif(current_setting('claudian_cloud.project_id', true), ''))
  WITH CHECK (project_id = nullif(current_setting('claudian_cloud.project_id', true), ''));

ALTER TABLE claudian_cloud.cloud_project_creation_journals
  ENABLE ROW LEVEL SECURITY;

ALTER TABLE claudian_cloud.cloud_project_creation_journals
  FORCE ROW LEVEL SECURITY;

CREATE POLICY cloud_project_creation_journals_project_scope
  ON claudian_cloud.cloud_project_creation_journals
  USING (
    project_id = nullif(current_setting('claudian_cloud.project_id', true), '')
  )
  WITH CHECK (
    project_id = nullif(current_setting('claudian_cloud.project_id', true), '')
  );

ALTER TABLE claudian_cloud.project_invitations
  ENABLE ROW LEVEL SECURITY;

ALTER TABLE claudian_cloud.project_invitations
  FORCE ROW LEVEL SECURITY;

ALTER TABLE claudian_cloud.cloud_project_join_journals
  ENABLE ROW LEVEL SECURITY;

ALTER TABLE claudian_cloud.cloud_project_join_journals
  FORCE ROW LEVEL SECURITY;

ALTER TABLE claudian_cloud.protected_invitation_envelopes
  ENABLE ROW LEVEL SECURITY;

ALTER TABLE claudian_cloud.protected_invitation_envelopes
  FORCE ROW LEVEL SECURITY;

ALTER TABLE claudian_cloud.secret_replay_tombstones
  ENABLE ROW LEVEL SECURITY;

ALTER TABLE claudian_cloud.secret_replay_tombstones
  FORCE ROW LEVEL SECURITY;

ALTER TABLE claudian_cloud.project_membership_idempotency_tombstones
  ENABLE ROW LEVEL SECURITY;

ALTER TABLE claudian_cloud.project_membership_idempotency_tombstones
  FORCE ROW LEVEL SECURITY;

ALTER TABLE claudian_cloud.manager_responsibility_offers
  ENABLE ROW LEVEL SECURITY;

ALTER TABLE claudian_cloud.manager_responsibility_offers
  FORCE ROW LEVEL SECURITY;

ALTER TABLE claudian_cloud.project_member_removal_journals
  ENABLE ROW LEVEL SECURITY;

ALTER TABLE claudian_cloud.project_member_removal_journals
  FORCE ROW LEVEL SECURITY;

ALTER TABLE claudian_cloud.transferred_membership_claim_overrides
  ENABLE ROW LEVEL SECURITY;

ALTER TABLE claudian_cloud.transferred_membership_claim_overrides
  FORCE ROW LEVEL SECURITY;

ALTER TABLE claudian_cloud.protected_claim_override_envelopes
  ENABLE ROW LEVEL SECURITY;

ALTER TABLE claudian_cloud.protected_claim_override_envelopes
  FORCE ROW LEVEL SECURITY;

CREATE POLICY project_invitations_project_scope
  ON claudian_cloud.project_invitations
  USING (project_id = nullif(current_setting('claudian_cloud.project_id', true), ''))
  WITH CHECK (project_id = nullif(current_setting('claudian_cloud.project_id', true), ''));

CREATE POLICY cloud_project_join_journals_project_scope
  ON claudian_cloud.cloud_project_join_journals
  USING (project_id = nullif(current_setting('claudian_cloud.project_id', true), ''))
  WITH CHECK (project_id = nullif(current_setting('claudian_cloud.project_id', true), ''));

CREATE POLICY protected_invitation_envelopes_project_scope
  ON claudian_cloud.protected_invitation_envelopes
  USING (project_id = nullif(current_setting('claudian_cloud.project_id', true), ''))
  WITH CHECK (project_id = nullif(current_setting('claudian_cloud.project_id', true), ''));

CREATE POLICY secret_replay_tombstones_project_scope
  ON claudian_cloud.secret_replay_tombstones
  USING (project_id = nullif(current_setting('claudian_cloud.project_id', true), ''))
  WITH CHECK (project_id = nullif(current_setting('claudian_cloud.project_id', true), ''));

CREATE POLICY project_membership_idempotency_tombstones_project_scope
  ON claudian_cloud.project_membership_idempotency_tombstones
  USING (project_id = nullif(current_setting('claudian_cloud.project_id', true), ''))
  WITH CHECK (project_id = nullif(current_setting('claudian_cloud.project_id', true), ''));

CREATE POLICY manager_responsibility_offers_project_scope
  ON claudian_cloud.manager_responsibility_offers
  USING (project_id = nullif(current_setting('claudian_cloud.project_id', true), ''))
  WITH CHECK (project_id = nullif(current_setting('claudian_cloud.project_id', true), ''));

CREATE POLICY project_member_removal_journals_project_scope
  ON claudian_cloud.project_member_removal_journals
  USING (project_id = nullif(current_setting('claudian_cloud.project_id', true), ''))
  WITH CHECK (project_id = nullif(current_setting('claudian_cloud.project_id', true), ''));

CREATE POLICY transferred_membership_claim_overrides_project_scope
  ON claudian_cloud.transferred_membership_claim_overrides
  USING (project_id = nullif(current_setting('claudian_cloud.project_id', true), ''))
  WITH CHECK (project_id = nullif(current_setting('claudian_cloud.project_id', true), ''));

CREATE POLICY protected_claim_override_envelopes_project_scope
  ON claudian_cloud.protected_claim_override_envelopes
  USING (project_id = nullif(current_setting('claudian_cloud.project_id', true), ''))
  WITH CHECK (project_id = nullif(current_setting('claudian_cloud.project_id', true), ''));

-- Runtime privileges. Column grants deliberately restrict mutable journal facts.

REVOKE ALL ON ALL TABLES IN SCHEMA claudian_cloud FROM PUBLIC;

REVOKE ALL ON FUNCTION claudian_cloud.find_development_bootstrap_project(requested_attempt_id varchar) FROM PUBLIC;
GRANT ALL ON FUNCTION claudian_cloud.find_development_bootstrap_project(requested_attempt_id varchar) TO claudian_cloud_runtime;
REVOKE ALL ON FUNCTION claudian_cloud.put_development_bootstrap_attempt_route(requested_attempt_id varchar, requested_project_id varchar) FROM PUBLIC;
GRANT ALL ON FUNCTION claudian_cloud.put_development_bootstrap_attempt_route(requested_attempt_id varchar, requested_project_id varchar) TO claudian_cloud_runtime;
REVOKE ALL ON FUNCTION claudian_cloud.register_project_terminal_continuity() FROM PUBLIC;
REVOKE ALL ON FUNCTION claudian_cloud.remove_project_coordination_content(requested_project_id varchar, requested_operation_id varchar, requested_terminal_operation_kind text, requested_terminal_operation_id varchar) FROM PUBLIC;
GRANT ALL ON FUNCTION claudian_cloud.remove_project_coordination_content(requested_project_id varchar, requested_operation_id varchar, requested_terminal_operation_kind text, requested_terminal_operation_id varchar) TO claudian_cloud_runtime;
GRANT SELECT, INSERT ON TABLE claudian_cloud.accept_journal_relations TO claudian_cloud_runtime;
GRANT SELECT, INSERT ON TABLE claudian_cloud.accept_journals TO claudian_cloud_runtime;
GRANT SELECT, INSERT, DELETE, UPDATE ON TABLE claudian_cloud.active_repository_placement_catalog TO claudian_cloud_runtime;
GRANT SELECT, INSERT ON TABLE claudian_cloud.authority_transfer_recovery TO claudian_cloud_runtime;
GRANT SELECT, INSERT, DELETE, UPDATE ON TABLE claudian_cloud.change_requests TO claudian_cloud_runtime;
GRANT SELECT, INSERT, DELETE, UPDATE ON TABLE claudian_cloud.cloud_project_creation_journals TO claudian_cloud_runtime;
GRANT SELECT, INSERT, DELETE, UPDATE ON TABLE claudian_cloud.cloud_project_join_journals TO claudian_cloud_runtime;
GRANT SELECT, INSERT, DELETE, UPDATE ON TABLE claudian_cloud.development_actor_mappings TO claudian_cloud_runtime;
GRANT SELECT, INSERT, DELETE, UPDATE ON TABLE claudian_cloud.development_bootstrap_attempts TO claudian_cloud_runtime;
GRANT SELECT, INSERT, DELETE, UPDATE ON TABLE claudian_cloud.development_bootstrap_expiry_candidates TO claudian_cloud_runtime;
GRANT SELECT, INSERT, DELETE, UPDATE ON TABLE claudian_cloud.development_bootstrap_reports TO claudian_cloud_runtime;
GRANT SELECT, INSERT, DELETE, UPDATE ON TABLE claudian_cloud.development_bootstrap_settlements TO claudian_cloud_runtime;
GRANT SELECT, INSERT, DELETE, UPDATE ON TABLE claudian_cloud.development_bootstrap_uploads TO claudian_cloud_runtime;
GRANT SELECT, INSERT, DELETE ON TABLE claudian_cloud.idempotency_results TO claudian_cloud_runtime;
GRANT SELECT, INSERT ON TABLE claudian_cloud.leave_former_principal_replays TO claudian_cloud_runtime;
GRANT SELECT, INSERT, DELETE, UPDATE ON TABLE claudian_cloud.leave_project_request_facts TO claudian_cloud_runtime;
GRANT SELECT, INSERT, DELETE, UPDATE ON TABLE claudian_cloud.manager_responsibility_offers TO claudian_cloud_runtime;
GRANT SELECT, INSERT ON TABLE claudian_cloud.project_backup_catalog TO claudian_cloud_runtime;
GRANT SELECT, INSERT ON TABLE claudian_cloud.project_deletion_intents TO claudian_cloud_runtime;
GRANT SELECT, INSERT, UPDATE ON TABLE claudian_cloud.project_event_sequences TO claudian_cloud_runtime;
GRANT SELECT, INSERT, DELETE ON TABLE claudian_cloud.project_events TO claudian_cloud_runtime;
GRANT SELECT, INSERT, DELETE, UPDATE ON TABLE claudian_cloud.project_invitations TO claudian_cloud_runtime;
GRANT SELECT, INSERT ON TABLE claudian_cloud.project_lifecycle_journals TO claudian_cloud_runtime;
GRANT SELECT, INSERT, DELETE, UPDATE ON TABLE claudian_cloud.project_member_removal_journals TO claudian_cloud_runtime;
GRANT SELECT, INSERT, DELETE, UPDATE ON TABLE claudian_cloud.project_membership_idempotency_tombstones TO claudian_cloud_runtime;
GRANT SELECT, INSERT, DELETE, UPDATE ON TABLE claudian_cloud.project_memberships TO claudian_cloud_runtime;
GRANT SELECT, INSERT ON TABLE claudian_cloud.project_principal_bindings TO claudian_cloud_runtime;
GRANT SELECT, INSERT ON TABLE claudian_cloud.project_terminal_acknowledgements TO claudian_cloud_runtime;
GRANT SELECT ON TABLE claudian_cloud.project_terminal_continuity_catalog TO claudian_cloud_runtime;
GRANT SELECT, INSERT, DELETE ON TABLE claudian_cloud.project_terminal_responder_catalog TO claudian_cloud_runtime;
GRANT SELECT, INSERT, DELETE ON TABLE claudian_cloud.project_terminal_responders TO claudian_cloud_runtime;
GRANT SELECT, INSERT ON TABLE claudian_cloud.project_tombstones TO claudian_cloud_runtime;
GRANT SELECT, INSERT, DELETE, UPDATE ON TABLE claudian_cloud.projects TO claudian_cloud_runtime;
GRANT SELECT, INSERT, DELETE, UPDATE ON TABLE claudian_cloud.protected_claim_override_envelopes TO claudian_cloud_runtime;
GRANT SELECT, INSERT, DELETE, UPDATE ON TABLE claudian_cloud.protected_invitation_envelopes TO claudian_cloud_runtime;
GRANT SELECT, INSERT, DELETE, UPDATE ON TABLE claudian_cloud.recovery_candidates TO claudian_cloud_runtime;
GRANT SELECT, INSERT, DELETE, UPDATE ON TABLE claudian_cloud.repository_placements TO claudian_cloud_runtime;
GRANT SELECT, INSERT, DELETE ON TABLE claudian_cloud.request_comments TO claudian_cloud_runtime;
GRANT SELECT, INSERT, DELETE, UPDATE ON TABLE claudian_cloud.request_ticket_relations TO claudian_cloud_runtime;
GRANT SELECT, INSERT, DELETE, UPDATE ON TABLE claudian_cloud.secret_replay_tombstones TO claudian_cloud_runtime;
GRANT SELECT, INSERT, DELETE ON TABLE claudian_cloud.source_protected_claim_envelopes TO claudian_cloud_runtime;
GRANT SELECT, INSERT, DELETE ON TABLE claudian_cloud.ticket_comments TO claudian_cloud_runtime;
GRANT SELECT, INSERT, DELETE ON TABLE claudian_cloud.ticket_mentions TO claudian_cloud_runtime;
GRANT SELECT, INSERT, DELETE, UPDATE ON TABLE claudian_cloud.tickets TO claudian_cloud_runtime;
GRANT SELECT, INSERT ON TABLE claudian_cloud.transfer_claim_batch_receipts TO claudian_cloud_runtime;
GRANT SELECT, INSERT, DELETE ON TABLE claudian_cloud.transfer_receipt_keys TO claudian_cloud_runtime;
GRANT SELECT, INSERT, DELETE ON TABLE claudian_cloud.transfer_redemption_receipts TO claudian_cloud_runtime;
GRANT SELECT, INSERT, DELETE, UPDATE ON TABLE claudian_cloud.transferred_membership_claim_overrides TO claudian_cloud_runtime;
GRANT SELECT, INSERT, DELETE ON TABLE claudian_cloud.transferred_membership_claims TO claudian_cloud_runtime;
GRANT UPDATE (phase, recovery_from_phase, result_oid, updated_at)
  ON claudian_cloud.accept_journals TO claudian_cloud_runtime;
GRANT UPDATE (expires_at, source_proof, target_proof, stage_sha256, target_activation_proof, relinquishment_proof_json, updated_at, cancellation_request_sha256, source_reopen_sha256, inactive_publication_json, target_activation_request_sha256)
  ON claudian_cloud.authority_transfer_recovery TO claudian_cloud_runtime;
GRANT UPDATE (state, result_sha256, completed_at)
  ON claudian_cloud.leave_former_principal_replays TO claudian_cloud_runtime;
GRANT UPDATE (state, verified_at, published_at)
  ON claudian_cloud.project_backup_catalog TO claudian_cloud_runtime;
GRANT UPDATE (phase, recovery_from_phase, state, checkpoint_sha256, batch_revision, batch_sha256, result_sha256, scheduled_at, updated_at)
  ON claudian_cloud.project_lifecycle_journals TO claudian_cloud_runtime;
GRANT UPDATE (state, revoked_at)
  ON claudian_cloud.project_principal_bindings TO claudian_cloud_runtime;
GRANT UPDATE (acknowledged_at)
  ON claudian_cloud.project_terminal_acknowledgements TO claudian_cloud_runtime;
GRANT UPDATE (expires_at)
  ON claudian_cloud.source_protected_claim_envelopes TO claudian_cloud_runtime;
GRANT UPDATE (acknowledged_at)
  ON claudian_cloud.transfer_redemption_receipts TO claudian_cloud_runtime;
GRANT UPDATE (state, target_principal_id, operation_intent_id, redemption_receipt_id, updated_at)
  ON claudian_cloud.transferred_membership_claims TO claudian_cloud_runtime;
