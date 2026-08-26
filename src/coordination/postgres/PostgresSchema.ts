export const FOUNDATION_SCHEMA = Object.freeze({
  checksum: '5e883d93536b2569f3655cc9f3982c4ad7e8e3daf7871500dc5d4f471e8504bb',
  name: 'foundation',
  version: 1,
});

export const DEVELOPMENT_BOOTSTRAP_SCHEMA = Object.freeze({
  checksum: '18d367c9ef8a0d39d0d072bc2ed89b1b6f75bf306585adb6138c66b3e5a9afe6',
  name: 'development-bootstrap',
  version: 2,
});

export const PROJECT_READ_EVENTS_SCHEMA = Object.freeze({
  checksum: 'd490c9083abc5e0294c9d144d832b5070040276d716555d398ca80456aecf9d8',
  name: 'project-read-events',
  version: 3,
});

export const COLLABORATION_SCHEMA = Object.freeze({
  checksum: '13ee2c7de2b189fb502a6610bff250f9de9133a82d79c153658251cf7f5a5780',
  name: 'collaboration',
  version: 4,
});

export const ACCEPT_RECOVERY_SCHEMA = Object.freeze({
  checksum: '0f0e91dd7be0ac961222c8802925425b87d6b540f87f1eebca89bde3efb4a1bd',
  name: 'accept-recovery',
  version: 5,
});

export const PORTABILITY_LIFECYCLE_SCHEMA = Object.freeze({
  checksum: 'a7c4773253250fc0c02e0e6f02026b22ef7f1767a19ff922947a30f843160de6',
  name: 'portability-lifecycle',
  version: 6,
});

export const LAN_TO_CLOUD_TRANSFER_SCHEMA = Object.freeze({
  checksum: 'd49bf1335d3410cdd95ff2b928f21264eb6212e7db9baea6561d118038d06a95',
  name: 'lan-to-cloud-transfer',
  version: 7,
});

export const CLOUD_TO_LAN_TRANSFER_SCHEMA = Object.freeze({
  checksum: '12e60f0ef26d2906687635cc4bdc59f33cb3bbfbc2095d2e7196b57417eb0e12',
  name: 'cloud-to-lan-transfer',
  version: 8,
});

export const TERMINAL_PROJECT_LIFECYCLE_SCHEMA = Object.freeze({
  checksum: 'f5a9541802d114f0959b2e62c9a884cba938c99926fe9547063d95a457a6d284',
  name: 'terminal-project-lifecycle',
  version: 9,
});

export const POSTGRES_SCHEMAS = Object.freeze([
  FOUNDATION_SCHEMA,
  DEVELOPMENT_BOOTSTRAP_SCHEMA,
  PROJECT_READ_EVENTS_SCHEMA,
  COLLABORATION_SCHEMA,
  ACCEPT_RECOVERY_SCHEMA,
  PORTABILITY_LIFECYCLE_SCHEMA,
  LAN_TO_CLOUD_TRANSFER_SCHEMA,
  CLOUD_TO_LAN_TRANSFER_SCHEMA,
  TERMINAL_PROJECT_LIFECYCLE_SCHEMA,
]);
