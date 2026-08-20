# Vendored protocol artifact

This directory temporarily contains the exact canonical Collab protocol package consumed during private Cloud Server development. Claudian remains the source owner. Cloud Server must replace this artifact with an exact npm dependency before Cloud service development is declared complete.

## Provenance

- Producer repository: `YishenTu/claudian`
- Selected producer ref: `origin/main`
- Observed producer revision: `9c4d92f63808f88219d7af00b45c0b6b5a9254dd`
- Package: `@claudian/collab-protocol`
- Package version: `0.3.0`
- Wire protocol version: `3`
- Operation count: `15`
- Pack command: `npm pack --json --pack-destination <cloud-server>/vendor`
- Artifact: `claudian-collab-protocol-0.3.0.tgz`
- SHA-1: `fb1e9935b9db263b2f1137b8a63e7b3c021fa00c`
- Integrity: `sha512-MFTrGQxjj6zXLJHNRxMstoj1jAdjVx3T+PbbUYooscy22vKoQKB59Km1Z9aw+FO5G7PDdEjPLXwfeXBzrZca0w==`

Producer verification on 2026-08-21 passed 11 test suites and 83 tests. `npm run verify:pack` accepted an exact 26-file inventory, CommonJS and ESM loading, and blocked package subpath imports.
