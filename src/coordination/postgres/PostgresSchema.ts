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
  checksum: '805b760962abb27c085e97b977cf443c5febbfb3cd1fc3024f9f94e157dc7c40',
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
  checksum: '432a787b07efbee791ea62b583334860f48343689c5b67e9ae101aa1927322b7',
  name: 'lan-to-cloud-transfer',
  version: 7,
});

export const CLOUD_TO_LAN_TRANSFER_SCHEMA = Object.freeze({
  checksum: '12e60f0ef26d2906687635cc4bdc59f33cb3bbfbc2095d2e7196b57417eb0e12',
  name: 'cloud-to-lan-transfer',
  version: 8,
});

export const TERMINAL_PROJECT_LIFECYCLE_SCHEMA = Object.freeze({
  checksum: 'cc494cde24e15af6b3c171a12d0754fb82d7c1cd301744eebb744bcadce79711',
  name: 'terminal-project-lifecycle',
  version: 9,
});

export const TERMINAL_CONTINUITY_CATALOG_SCHEMA = Object.freeze({
  checksum: '5be7f9a48ab505d9a950c310605d696abc8b11b9435018cd72f41769a2b917f1',
  name: 'terminal-continuity-catalog',
  version: 10,
});

export const CLOUD_PROJECT_MEMBERSHIP_SCHEMA = Object.freeze({
  checksum: '1d745589d66d8636537be28a7b3e9e987d0996e5cac98f68cf7fae703a6e9b9a',
  name: 'cloud-project-membership',
  version: 11,
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
  TERMINAL_CONTINUITY_CATALOG_SCHEMA,
  CLOUD_PROJECT_MEMBERSHIP_SCHEMA,
]);
