import type {
  CollabGitOid,
  CollabIsoTimestamp,
  CollabMemberId,
  CollabProjectId,
} from '@claudian/collab-protocol';

export type ProjectServiceState = 'active' | 'recovery-required';

export interface ProjectRecord {
  readonly activatedAt: CollabIsoTimestamp;
  readonly createdAt: CollabIsoTimestamp;
  readonly expectedMainOid: CollabGitOid;
  readonly managerSetGeneration: number;
  readonly projectId: CollabProjectId;
  readonly projectName: string;
  readonly serviceState: ProjectServiceState;
}

export interface ProjectPersistence {
  findDevelopmentActorMember(actorId: string): Promise<CollabMemberId | undefined>;
  getProject(): Promise<ProjectRecord | undefined>;
}
