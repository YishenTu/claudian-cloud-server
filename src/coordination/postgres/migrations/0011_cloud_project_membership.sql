DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM claudian_cloud.project_lifecycle_journals WHERE kind = 'leave'
  ) OR EXISTS (
    SELECT 1 FROM claudian_cloud.leave_former_principal_replays
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '55000',
      MESSAGE = 'pre-3.3 Leave lifecycle state is unsupported';
  END IF;
END;
$$;

ALTER TABLE claudian_cloud.recovery_candidates
  DROP CONSTRAINT recovery_candidates_kind,
  ADD CONSTRAINT recovery_candidates_kind
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
    );

ALTER TABLE claudian_cloud.project_lifecycle_journals
  DROP CONSTRAINT project_lifecycle_journals_kind,
  ADD CONSTRAINT project_lifecycle_journals_kind
    CHECK (kind IN (
      'authority-transfer', 'backup', 'delete', 'export', 'leave',
      'remove-member', 'retire'
    )),
  DROP CONSTRAINT project_lifecycle_journals_leave_ref,
  ADD CONSTRAINT project_lifecycle_journals_leave_ref
    CHECK (
      (kind IN ('leave', 'remove-member'))
        = (expected_personal_ref_oid IS NOT NULL)
      AND (
        expected_personal_ref_oid IS NULL
        OR expected_personal_ref_oid ~ '^(?:[0-9a-f]{40}|[0-9a-f]{64})$'
      )
    );

ALTER TABLE claudian_cloud.project_principal_bindings
  DROP CONSTRAINT project_principal_bindings_state,
  ADD CONSTRAINT project_principal_bindings_state
    CHECK (
      (state IN ('active', 'pending') AND revoked_at IS NULL)
      OR (state = 'revoked' AND revoked_at >= bound_at)
    );

ALTER TABLE claudian_cloud.leave_former_principal_replays
  ADD COLUMN response_json text NOT NULL,
  ADD CONSTRAINT leave_former_principal_replays_response
    CHECK (octet_length(response_json) BETWEEN 2 AND 65536);

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

ALTER TABLE claudian_cloud.leave_project_request_facts
  ENABLE ROW LEVEL SECURITY;
ALTER TABLE claudian_cloud.leave_project_request_facts
  FORCE ROW LEVEL SECURITY;

CREATE POLICY leave_project_request_facts_project_scope
  ON claudian_cloud.leave_project_request_facts
  USING (project_id = nullif(current_setting('claudian_cloud.project_id', true), ''))
  WITH CHECK (project_id = nullif(current_setting('claudian_cloud.project_id', true), ''));

REVOKE ALL ON claudian_cloud.leave_project_request_facts FROM PUBLIC;
GRANT SELECT, INSERT, UPDATE, DELETE
  ON claudian_cloud.leave_project_request_facts
  TO claudian_cloud_runtime;

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

REVOKE ALL ON claudian_cloud.cloud_project_creation_journals FROM PUBLIC;
GRANT SELECT, INSERT, UPDATE, DELETE
  ON claudian_cloud.cloud_project_creation_journals
  TO claudian_cloud_runtime;

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

CREATE UNIQUE INDEX cloud_project_join_journals_nonterminal
  ON claudian_cloud.cloud_project_join_journals(project_id)
  WHERE phase <> 'completed';

CREATE INDEX project_invitations_current
  ON claudian_cloud.project_invitations(project_id, state, invitation_id);

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

CREATE TABLE claudian_cloud.project_membership_idempotency_results (
  project_id varchar(64) NOT NULL,
  actor_member_id varchar(64) NOT NULL,
  operation text NOT NULL,
  idempotency_key varchar(128) NOT NULL,
  request_fingerprint char(64) NOT NULL,
  result_json text NOT NULL,
  created_at timestamptz NOT NULL,
  PRIMARY KEY (project_id, actor_member_id, operation, idempotency_key),
  CONSTRAINT project_membership_idempotency_results_actor
    FOREIGN KEY (project_id, actor_member_id)
    REFERENCES claudian_cloud.project_memberships(project_id, member_id),
  CONSTRAINT project_membership_idempotency_results_operation
    CHECK (operation IN (
      'revokeProjectInvitation',
      'revokeTransferredMembershipClaim',
      'createManagerResponsibilityOffer',
      'acknowledgeManagerResponsibility',
      'declineManagerResponsibility',
      'cancelManagerResponsibilityOffer',
      'promoteManager',
      'demoteManager'
    )),
  CONSTRAINT project_membership_idempotency_results_key
    CHECK (idempotency_key ~ '^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$'),
  CONSTRAINT project_membership_idempotency_results_fingerprint
    CHECK (request_fingerprint ~ '^[0-9a-f]{64}$'),
  CONSTRAINT project_membership_idempotency_results_result
    CHECK (octet_length(result_json) BETWEEN 2 AND 65536)
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

CREATE UNIQUE INDEX transferred_membership_claim_overrides_effective
  ON claudian_cloud.transferred_membership_claim_overrides(
    project_id, transfer_id, member_id
  )
  WHERE state = 'active';

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
ALTER TABLE claudian_cloud.project_membership_idempotency_results
  ENABLE ROW LEVEL SECURITY;
ALTER TABLE claudian_cloud.project_membership_idempotency_results
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
CREATE POLICY project_membership_idempotency_results_project_scope
  ON claudian_cloud.project_membership_idempotency_results
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

REVOKE ALL ON
  claudian_cloud.project_invitations,
  claudian_cloud.cloud_project_join_journals,
  claudian_cloud.protected_invitation_envelopes,
  claudian_cloud.secret_replay_tombstones,
  claudian_cloud.project_membership_idempotency_results,
  claudian_cloud.project_membership_idempotency_tombstones,
  claudian_cloud.manager_responsibility_offers,
  claudian_cloud.project_member_removal_journals,
  claudian_cloud.transferred_membership_claim_overrides,
  claudian_cloud.protected_claim_override_envelopes
FROM PUBLIC;
GRANT SELECT, INSERT, UPDATE, DELETE ON
  claudian_cloud.project_invitations,
  claudian_cloud.cloud_project_join_journals,
  claudian_cloud.protected_invitation_envelopes,
  claudian_cloud.secret_replay_tombstones,
  claudian_cloud.project_membership_idempotency_results,
  claudian_cloud.project_membership_idempotency_tombstones,
  claudian_cloud.manager_responsibility_offers,
  claudian_cloud.project_member_removal_journals,
  claudian_cloud.transferred_membership_claim_overrides,
  claudian_cloud.protected_claim_override_envelopes
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
  DELETE FROM claudian_cloud.project_membership_idempotency_results
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
