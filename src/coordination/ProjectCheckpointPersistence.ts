import type {
  CollabCheckpointPortableRecord,
  CollabCheckpointProfile,
  CollabIsoTimestamp,
  CollabProjectBackupRecord,
  CollabMemberId,
  CollabProjectId,
} from '@claudian-collab/protocol';

export type ProjectCheckpointRecord =
  | CollabCheckpointPortableRecord
  | CollabProjectBackupRecord;

export interface TerminalProjectTombstoneRecord {
  readonly kind: 'tombstone';
  readonly recordId: string;
  readonly revision: number;
  readonly value: {
    readonly authorityGeneration: number;
    readonly projectId: CollabProjectId;
    readonly resultSha256: string;
    readonly retiredAt: CollabIsoTimestamp;
    readonly terminalExpiresAt: CollabIsoTimestamp;
    readonly terminalOperationId: string;
    readonly terminalOperationKind: 'authority-transfer' | 'retire';
    readonly returnHostMemberId: CollabMemberId | null;
    readonly returnPrincipalId: string | null;
    readonly returnAuthorityFingerprint: string | null;
  };
}

export type TerminalProjectContinuityRecord = TerminalProjectTombstoneRecord | Extract<
  CollabProjectBackupRecord,
  { readonly kind:
    | 'lifecycle-journal'
    | 'protected-claim-envelope'
    | 'terminal-principal'
    | 'terminal-responder'
    | 'terminal-responder-replay'
    | 'transfer-receipt-key'
    | 'transfer-redemption-receipt'
  }
>;

export interface ProjectCheckpointSnapshotMetadata {
  readonly authorityId: string;
  readonly authorityVolumeIdentity: string;
  readonly coordinationSchemaVersion: number;
  readonly maximumServerBuild: string;
  readonly minimumServerBuild: string;
  readonly repositoryFormatVersion: number;
  readonly restoreEpoch: number;
}

export interface ReadProjectCheckpointRecordsInput {
  /** Excludes only the checkpoint operation currently being captured. */
  readonly excludedOperationId?: string;
  readonly maximumCoordinationBytes: number;
  readonly metadata: ProjectCheckpointSnapshotMetadata;
  readonly profile: CollabCheckpointProfile;
  readonly snapshotAt: CollabIsoTimestamp;
}

/** Logical, engine-independent Project checkpoint serialization seam. */
export interface ProjectCheckpointPersistence {
  readProjectCheckpointRecords(
    input: ReadProjectCheckpointRecordsInput,
  ): Promise<readonly ProjectCheckpointRecord[]>;
  readTerminalProjectContinuityRecords(input: Readonly<{
    readonly maximumCoordinationBytes: number;
  }>): Promise<readonly TerminalProjectContinuityRecord[]>;
}
