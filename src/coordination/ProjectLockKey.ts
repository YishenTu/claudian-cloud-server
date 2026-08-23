import { createHash } from 'node:crypto';

import {
  isCollabOpaqueId,
  isCollabProjectId,
  type CollabProjectId,
} from '@claudian-collab/protocol';

import { CoordinationError } from './CoordinationError.js';

const PROJECT_LOCK_NAMESPACE = 'claudian-cloud/project-lock/v1\0';
const DEVELOPMENT_BOOTSTRAP_UPLOAD_LOCK_NAMESPACE =
  'claudian-cloud/development-bootstrap-upload-lock/v1\0';

function lockKey(namespace: string, identity: string): bigint {
  const digest = createHash('sha256')
    .update(namespace, 'utf8')
    .update(identity, 'utf8')
    .digest();
  return digest.readBigInt64BE(0);
}

export function projectLockKey(projectId: CollabProjectId): bigint {
  if (!isCollabProjectId(projectId)) {
    throw new CoordinationError('invalid-project');
  }
  return lockKey(PROJECT_LOCK_NAMESPACE, projectId);
}

export function developmentBootstrapUploadLockKey(
  projectId: CollabProjectId,
  attemptId: string,
): bigint {
  if (!isCollabProjectId(projectId)) {
    throw new CoordinationError('invalid-project');
  }
  if (!isCollabOpaqueId(attemptId)) {
    throw new CoordinationError('invalid-record');
  }
  return lockKey(
    DEVELOPMENT_BOOTSTRAP_UPLOAD_LOCK_NAMESPACE,
    `${projectId}\0${attemptId}`,
  );
}
