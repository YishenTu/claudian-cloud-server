CREATE TABLE claudian_cloud.projects (
  project_id varchar(64) PRIMARY KEY,
  created_at timestamptz NOT NULL,
  CONSTRAINT projects_project_id_format
    CHECK (project_id ~ '^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$')
);

CREATE TABLE claudian_cloud.project_memberships (
  project_id varchar(64) NOT NULL,
  member_id varchar(64) NOT NULL,
  role text NOT NULL,
  status text NOT NULL,
  revision bigint NOT NULL,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  PRIMARY KEY (project_id, member_id),
  CONSTRAINT project_memberships_project
    FOREIGN KEY (project_id)
    REFERENCES claudian_cloud.projects(project_id),
  CONSTRAINT project_memberships_member_id_format
    CHECK (member_id ~ '^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$'),
  CONSTRAINT project_memberships_role
    CHECK (role IN ('manager', 'member')),
  CONSTRAINT project_memberships_status
    CHECK (status IN ('pending', 'active', 'revoked', 'left')),
  CONSTRAINT project_memberships_revision
    CHECK (revision > 0),
  CONSTRAINT project_memberships_timestamps
    CHECK (updated_at >= created_at)
);

CREATE INDEX project_memberships_by_status
  ON claudian_cloud.project_memberships(project_id, status, member_id);

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
    CHECK (repository_storage_key ~ '^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$'),
  CONSTRAINT repository_placements_generation
    CHECK (generation BETWEEN 1 AND 9007199254740991),
  CONSTRAINT repository_placements_timestamps
    CHECK (updated_at >= created_at)
);

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

REVOKE ALL ON ALL TABLES IN SCHEMA claudian_cloud FROM PUBLIC;
GRANT SELECT, INSERT, UPDATE, DELETE
  ON claudian_cloud.projects,
     claudian_cloud.project_memberships,
     claudian_cloud.repository_placements
  TO claudian_cloud_runtime;
