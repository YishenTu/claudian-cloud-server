import type {
  CollabCheckpointPortableRecord,
  CollabCheckpointProfile,
  CollabIsoTimestamp,
  CollabProjectBackupRecord,
} from '@claudian-collab/protocol';

export type ProjectCheckpointRecord =
  | CollabCheckpointPortableRecord
  | CollabProjectBackupRecord;

export type TerminalProjectContinuityRecord = Extract<
  CollabProjectBackupRecord,
  { readonly kind:
    | 'lifecycle-journal'
    | 'protected-claim-envelope'
    | 'terminal-principal'
    | 'terminal-responder'
    | 'terminal-responder-replay'
    | 'tombstone'
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
  readonly profile: Extract<CollabCheckpointProfile, 'backup' | 'export'>;
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
