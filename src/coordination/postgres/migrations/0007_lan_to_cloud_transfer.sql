ALTER TABLE claudian_cloud.authority_transfer_recovery
  ADD COLUMN cancellation_request_sha256 char(64),
  ADD COLUMN source_reopen_sha256 char(64),
  ADD COLUMN inactive_publication_json text,
  ADD CONSTRAINT authority_transfer_recovery_lan_to_cloud_evidence
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
    );

ALTER TABLE claudian_cloud.project_memberships
  ADD COLUMN activated_at timestamptz,
  ADD COLUMN revoked_at timestamptz;

UPDATE claudian_cloud.project_memberships
   SET activated_at = CASE
         WHEN status = 'pending' THEN NULL
         ELSE updated_at
       END,
       revoked_at = CASE
         WHEN status = 'revoked' THEN updated_at
         ELSE NULL
       END;

ALTER TABLE claudian_cloud.project_memberships
  ADD CONSTRAINT project_memberships_lifecycle_timestamps
    CHECK (
      (activated_at IS NULL OR activated_at >= created_at)
      AND (revoked_at IS NULL OR revoked_at >= created_at)
      AND (
        activated_at IS NULL
        OR revoked_at IS NULL
        OR revoked_at >= activated_at
      )
    );

ALTER TABLE claudian_cloud.project_events
  DROP CONSTRAINT project_events_kind,
  ADD CONSTRAINT project_events_kind
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
    ));

GRANT UPDATE (
  cancellation_request_sha256,
  source_reopen_sha256,
  inactive_publication_json
) ON claudian_cloud.authority_transfer_recovery
TO claudian_cloud_runtime;

GRANT DELETE ON claudian_cloud.transferred_membership_claims
TO claudian_cloud_runtime;

GRANT DELETE ON
  claudian_cloud.change_requests,
  claudian_cloud.request_comments,
  claudian_cloud.tickets,
  claudian_cloud.ticket_comments
TO claudian_cloud_runtime;
