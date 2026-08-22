ALTER TABLE claudian_cloud.request_ticket_relations
  ADD CONSTRAINT request_ticket_relations_accept_journal_identity
  UNIQUE (project_id, relation_id, request_id, ticket_id);

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

CREATE UNIQUE INDEX accept_journals_one_nonterminal
  ON claudian_cloud.accept_journals(project_id)
  WHERE phase <> 'completed';

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

REVOKE ALL ON claudian_cloud.accept_journals FROM PUBLIC;
REVOKE ALL ON claudian_cloud.accept_journal_relations FROM PUBLIC;

GRANT SELECT, INSERT
  ON claudian_cloud.accept_journals,
     claudian_cloud.accept_journal_relations
  TO claudian_cloud_runtime;
GRANT UPDATE (phase, recovery_from_phase, result_oid, updated_at)
  ON claudian_cloud.accept_journals
  TO claudian_cloud_runtime;
