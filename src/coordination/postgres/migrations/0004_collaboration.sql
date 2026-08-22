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

CREATE UNIQUE INDEX change_requests_one_open_per_member
  ON claudian_cloud.change_requests(project_id, member_id)
  WHERE status = 'open';

CREATE INDEX change_requests_open_snapshot
  ON claudian_cloud.change_requests(project_id, request_id)
  WHERE status = 'open';

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

CREATE INDEX request_comments_by_request
  ON claudian_cloud.request_comments(
    project_id,
    request_id,
    created_at,
    comment_id
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

CREATE INDEX tickets_by_status_updated
  ON claudian_cloud.tickets(
    project_id,
    status,
    updated_at DESC,
    ticket_number DESC
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

CREATE INDEX ticket_comments_by_ticket
  ON claudian_cloud.ticket_comments(
    project_id,
    ticket_id,
    created_at,
    comment_id
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
    CHECK (updated_at >= created_at AND (accepted_at IS NULL OR accepted_at >= created_at))
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

CREATE INDEX ticket_mentions_by_member
  ON claudian_cloud.ticket_mentions(
    project_id,
    mentioned_member_id,
    created_at,
    ticket_id
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
    CHECK (jsonb_typeof(response_json) = 'object')
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

REVOKE ALL ON claudian_cloud.change_requests FROM PUBLIC;
REVOKE ALL ON claudian_cloud.request_comments FROM PUBLIC;
REVOKE ALL ON claudian_cloud.tickets FROM PUBLIC;
REVOKE ALL ON claudian_cloud.ticket_comments FROM PUBLIC;
REVOKE ALL ON claudian_cloud.request_ticket_relations FROM PUBLIC;
REVOKE ALL ON claudian_cloud.ticket_mentions FROM PUBLIC;
REVOKE ALL ON claudian_cloud.idempotency_results FROM PUBLIC;

GRANT SELECT, INSERT, UPDATE
  ON claudian_cloud.change_requests,
     claudian_cloud.tickets
  TO claudian_cloud_runtime;
GRANT SELECT, INSERT
  ON claudian_cloud.request_comments,
     claudian_cloud.ticket_comments,
     claudian_cloud.idempotency_results
  TO claudian_cloud_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE
  ON claudian_cloud.request_ticket_relations
  TO claudian_cloud_runtime;
GRANT SELECT, INSERT, DELETE
  ON claudian_cloud.ticket_mentions
  TO claudian_cloud_runtime;
