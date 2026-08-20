import { createHash } from 'node:crypto';

import {
  isCollabProjectId,
  type CollabProjectId,
} from '@claudian/collab-protocol';

import { CoordinationError } from './CoordinationError.js';

const PROJECT_LOCK_NAMESPACE = 'claudian-cloud/project-lock/v1\0';

export function projectLockKey(projectId: CollabProjectId): bigint {
  if (!isCollabProjectId(projectId)) {
    throw new CoordinationError('invalid-project');
  }
  const digest = createHash('sha256')
    .update(PROJECT_LOCK_NAMESPACE, 'utf8')
    .update(projectId, 'utf8')
    .digest();
  return digest.readBigInt64BE(0);
}
