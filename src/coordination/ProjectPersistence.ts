import type {
  CollabGitOid,
  CollabIsoTimestamp,
  CollabMemberId,
  CollabProjectId,
} from '@claudian-collab/protocol';

import type { PersistenceAdvanceResult } from './DevelopmentBootstrapPersistence.js';

export type ProjectServiceState =
  | 'active'
  | 'deleted'
  | 'deleting'
  | 'maintenance'
  | 'read-only-transition'
  | 'recovery-required';

export interface AdvanceProjectAuthorityStateInput {
  readonly expectedAuthorityGeneration: number;
  readonly expectedAuthorityStateRevision: number;
  readonly expectedServiceState: ProjectServiceState;
  readonly nextAuthorityGeneration: number;
  readonly nextServiceState: ProjectServiceState;
}

export interface ProjectRecord {
  readonly activatedAt: CollabIsoTimestamp;
  readonly authorityGeneration: number;
  readonly authorityStateRevision: number;
  readonly createdAt: CollabIsoTimestamp;
  readonly expectedMainOid: CollabGitOid;
  readonly managerSetGeneration: number;
  readonly projectId: CollabProjectId;
  readonly projectName: string;
  readonly serviceState: ProjectServiceState;
}

export interface ProjectPersistenceReader {
  findDevelopmentActorMember(actorId: string): Promise<CollabMemberId | undefined>;
  findPrincipalMember(principalId: string): Promise<CollabMemberId | undefined>;
  getProject(): Promise<ProjectRecord | undefined>;
}

export interface ProjectPersistence extends ProjectPersistenceReader {
  advanceProjectAuthorityState(
    input: AdvanceProjectAuthorityStateInput,
  ): Promise<PersistenceAdvanceResult>;
}
