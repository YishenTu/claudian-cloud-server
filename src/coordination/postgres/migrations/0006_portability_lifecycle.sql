ALTER TABLE claudian_cloud.projects
  ADD COLUMN authority_generation bigint NOT NULL DEFAULT 1,
  ADD COLUMN authority_state_revision bigint NOT NULL DEFAULT 1,
  ADD CONSTRAINT projects_authority_generation
    CHECK (authority_generation BETWEEN 1 AND 9007199254740991),
  ADD CONSTRAINT projects_authority_state_revision
    CHECK (authority_state_revision BETWEEN 1 AND 9007199254740991),
  DROP CONSTRAINT projects_service_state,
  ADD CONSTRAINT projects_service_state
    CHECK (
      service_state IN (
        'active',
        'deleted',
        'deleting',
        'maintenance',
        'read-only-transition',
        'recovery-required'
      )
    );

ALTER TABLE claudian_cloud.recovery_candidates
  DROP CONSTRAINT recovery_candidates_kind,
  ADD CONSTRAINT recovery_candidates_kind
    CHECK (
      kind IN (
        'activation',
        'accept',
        'authority-transfer',
        'backup',
        'delete',
        'export',
        'leave',
        'retire'
      )
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
  PRIMARY KEY (project_id, operation_id),
  CONSTRAINT project_lifecycle_journals_project_id
    CHECK (project_id ~ '^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$'),
  CONSTRAINT project_lifecycle_journals_operation_id
    CHECK (operation_id ~ '^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$'),
  CONSTRAINT project_lifecycle_journals_kind
    CHECK (kind IN ('authority-transfer', 'backup', 'delete', 'export', 'leave', 'retire')),
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
    CHECK (scheduled_at >= created_at AND updated_at >= created_at)
);

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
      (state = 'active' AND revoked_at IS NULL)
      OR (state = 'revoked' AND revoked_at >= bound_at)
    )
);

CREATE UNIQUE INDEX project_principal_bindings_active_member
  ON claudian_cloud.project_principal_bindings(project_id, member_id)
  WHERE state = 'active';

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
    CHECK (expires_at > created_at AND updated_at >= created_at)
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
    CHECK (expires_at > created_at AND updated_at >= created_at)
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
    CHECK (expires_at > created_at)
);

CREATE UNIQUE INDEX leave_former_principal_replays_exact_intent
  ON claudian_cloud.leave_former_principal_replays(
    project_id,
    principal_sha256,
    member_id,
    intent_id
  );

CREATE TABLE claudian_cloud.project_tombstones (
  project_id varchar(64) PRIMARY KEY,
  authority_generation bigint NOT NULL,
  terminal_operation_kind text NOT NULL,
  terminal_operation_id varchar(128) NOT NULL,
  result_sha256 char(64) NOT NULL,
  retired_at timestamptz NOT NULL,
  terminal_expires_at timestamptz NOT NULL,
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

CREATE UNIQUE INDEX project_deletion_one_per_project
  ON claudian_cloud.project_deletion_intents(project_id);

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
      JOIN claudian_cloud.project_terminal_responders AS responder
        ON responder.project_id = intent.project_id
       AND responder.operation_kind = intent.terminal_operation_kind
       AND responder.operation_id = intent.terminal_operation_id
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
   WHERE project_id = requested_project_id;
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

REVOKE ALL ON
  claudian_cloud.project_lifecycle_journals,
  claudian_cloud.project_principal_bindings,
  claudian_cloud.authority_transfer_recovery,
  claudian_cloud.transferred_membership_claims,
  claudian_cloud.transfer_receipt_keys,
  claudian_cloud.source_protected_claim_envelopes,
  claudian_cloud.transfer_claim_batch_receipts,
  claudian_cloud.transfer_redemption_receipts,
  claudian_cloud.project_terminal_responders,
  claudian_cloud.project_terminal_acknowledgements,
  claudian_cloud.leave_former_principal_replays,
  claudian_cloud.project_tombstones,
  claudian_cloud.project_deletion_intents,
  claudian_cloud.project_backup_catalog
FROM PUBLIC;

REVOKE ALL ON claudian_cloud.project_terminal_responder_catalog FROM PUBLIC;
REVOKE ALL ON FUNCTION claudian_cloud.remove_project_coordination_content(
  varchar,
  varchar,
  text,
  varchar
) FROM PUBLIC;

GRANT SELECT, INSERT ON
  claudian_cloud.project_lifecycle_journals,
  claudian_cloud.project_principal_bindings,
  claudian_cloud.authority_transfer_recovery,
  claudian_cloud.transferred_membership_claims,
  claudian_cloud.transfer_receipt_keys,
  claudian_cloud.source_protected_claim_envelopes,
  claudian_cloud.transfer_claim_batch_receipts,
  claudian_cloud.transfer_redemption_receipts,
  claudian_cloud.project_terminal_responders,
  claudian_cloud.project_terminal_acknowledgements,
  claudian_cloud.leave_former_principal_replays,
  claudian_cloud.project_tombstones,
  claudian_cloud.project_deletion_intents,
  claudian_cloud.project_backup_catalog
TO claudian_cloud_runtime;

GRANT SELECT, INSERT, DELETE
ON claudian_cloud.project_terminal_responder_catalog
TO claudian_cloud_runtime;

GRANT EXECUTE ON FUNCTION claudian_cloud.remove_project_coordination_content(
  varchar,
  varchar,
  text,
  varchar
) TO claudian_cloud_runtime;

GRANT UPDATE (
  phase,
  recovery_from_phase,
  state,
  checkpoint_sha256,
  batch_revision,
  batch_sha256,
  result_sha256,
  scheduled_at,
  updated_at
) ON claudian_cloud.project_lifecycle_journals
TO claudian_cloud_runtime;

GRANT UPDATE (state, revoked_at)
ON claudian_cloud.project_principal_bindings
TO claudian_cloud_runtime;

GRANT UPDATE (
  source_proof,
  target_proof,
  stage_sha256,
  target_activation_proof,
  relinquishment_proof_json,
  updated_at
) ON claudian_cloud.authority_transfer_recovery
TO claudian_cloud_runtime;

GRANT UPDATE (
  state,
  target_principal_id,
  operation_intent_id,
  redemption_receipt_id,
  updated_at
) ON claudian_cloud.transferred_membership_claims
TO claudian_cloud_runtime;

GRANT DELETE ON claudian_cloud.source_protected_claim_envelopes
TO claudian_cloud_runtime;

GRANT UPDATE (acknowledged_at)
ON claudian_cloud.transfer_redemption_receipts
TO claudian_cloud_runtime;

GRANT UPDATE (state, result_sha256, completed_at)
ON claudian_cloud.leave_former_principal_replays
TO claudian_cloud_runtime;

GRANT UPDATE (acknowledged_at)
ON claudian_cloud.project_terminal_acknowledgements
TO claudian_cloud_runtime;

GRANT DELETE ON claudian_cloud.project_terminal_responders
TO claudian_cloud_runtime;

GRANT UPDATE (state, verified_at, published_at)
ON claudian_cloud.project_backup_catalog
TO claudian_cloud_runtime;
