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
  CONSTRAINT project_events_kind
    CHECK (kind IN (
      'membership.updated',
      'request.updated',
      'request.comment-added',
      'ticket.updated',
      'ticket.comment-added',
      'main.updated'
    )),
  CONSTRAINT project_events_payload_object
    CHECK (jsonb_typeof(payload) = 'object')
);

CREATE INDEX project_events_by_retention
  ON claudian_cloud.project_events(project_id, occurred_at, sequence);

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

REVOKE ALL ON claudian_cloud.project_event_sequences FROM PUBLIC;
REVOKE ALL ON claudian_cloud.project_events FROM PUBLIC;
GRANT SELECT, INSERT, UPDATE
  ON claudian_cloud.project_event_sequences
  TO claudian_cloud_runtime;
GRANT SELECT, INSERT, DELETE
  ON claudian_cloud.project_events
  TO claudian_cloud_runtime;
