DO $$
BEGIN
  IF EXISTS (
    SELECT 1
      FROM claudian_cloud.leave_former_principal_replays
  ) OR EXISTS (
    SELECT 1
      FROM claudian_cloud.project_lifecycle_journals
     WHERE kind = 'leave'
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '55000',
      MESSAGE = 'legacy Leave lifecycle state requires operator recovery';
  END IF;
END;
$$;

ALTER TABLE claudian_cloud.project_memberships
  ADD COLUMN left_at timestamptz;

UPDATE claudian_cloud.project_memberships
   SET left_at = updated_at
 WHERE status = 'left';

ALTER TABLE claudian_cloud.project_memberships
  DROP CONSTRAINT project_memberships_lifecycle_timestamps,
  ADD CONSTRAINT project_memberships_lifecycle_timestamps
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
    );

ALTER TABLE claudian_cloud.leave_former_principal_replays
  ADD COLUMN expected_personal_ref_oid varchar(64) NOT NULL,
  ADD CONSTRAINT leave_former_principal_replays_expected_ref
    CHECK (expected_personal_ref_oid ~ '^(?:[0-9a-f]{40}|[0-9a-f]{64})$');

ALTER TABLE claudian_cloud.project_lifecycle_journals
  ADD COLUMN expected_personal_ref_oid varchar(64),
  ADD CONSTRAINT project_lifecycle_journals_leave_ref
    CHECK (
      (kind = 'leave') = (expected_personal_ref_oid IS NOT NULL)
      AND (
        expected_personal_ref_oid IS NULL
        OR expected_personal_ref_oid ~ '^(?:[0-9a-f]{40}|[0-9a-f]{64})$'
      )
    );

GRANT DELETE ON
  claudian_cloud.transfer_receipt_keys,
  claudian_cloud.transfer_redemption_receipts
TO claudian_cloud_runtime;

CREATE OR REPLACE FUNCTION claudian_cloud.remove_project_coordination_content(
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

  DELETE FROM claudian_cloud.leave_former_principal_replays
   WHERE project_id = requested_project_id;
  DELETE FROM claudian_cloud.project_principal_bindings
   WHERE project_id = requested_project_id;
  DELETE FROM claudian_cloud.transfer_redemption_receipts
   WHERE project_id = requested_project_id
     AND (
       requested_terminal_operation_kind <> 'authority-transfer'
       OR transfer_id <> requested_terminal_operation_id
       OR acknowledged_at IS NULL
     );
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
  DELETE FROM claudian_cloud.project_terminal_responders
   WHERE project_id = requested_project_id
     AND (operation_kind, operation_id)
         <> (requested_terminal_operation_kind, requested_terminal_operation_id);
  DELETE FROM claudian_cloud.recovery_candidates
   WHERE project_id = requested_project_id
     AND (kind <> 'delete' OR operation_id <> requested_operation_id);
  DELETE FROM claudian_cloud.project_lifecycle_journals AS journal
   WHERE journal.project_id = requested_project_id
     AND journal.operation_id <> requested_operation_id
     AND journal.operation_id <> requested_terminal_operation_id
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
