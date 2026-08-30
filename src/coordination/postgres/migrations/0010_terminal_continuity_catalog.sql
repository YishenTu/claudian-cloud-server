CREATE TABLE claudian_cloud.project_terminal_continuity_catalog (
  project_id varchar(64) PRIMARY KEY,
  retired_at timestamptz NOT NULL,
  CONSTRAINT project_terminal_continuity_catalog_tombstone
    FOREIGN KEY (project_id)
    REFERENCES claudian_cloud.project_tombstones(project_id)
    ON DELETE CASCADE,
  CONSTRAINT project_terminal_continuity_catalog_project_id
    CHECK (project_id ~ '^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$')
);

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

CREATE TRIGGER project_tombstones_register_terminal_continuity
AFTER INSERT ON claudian_cloud.project_tombstones
FOR EACH ROW
EXECUTE FUNCTION claudian_cloud.register_project_terminal_continuity();

REVOKE ALL ON claudian_cloud.project_terminal_continuity_catalog FROM PUBLIC;
REVOKE ALL ON FUNCTION claudian_cloud.register_project_terminal_continuity()
FROM PUBLIC;

GRANT SELECT ON claudian_cloud.project_terminal_continuity_catalog
TO claudian_cloud_runtime;
