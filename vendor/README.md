# Vendored protocol artifact

This directory temporarily contains the exact canonical Collab protocol package consumed during private Cloud Server development. Claudian remains the source owner. Cloud Server must replace this artifact with an exact npm dependency before Cloud service development is declared complete.

## Provenance

- Producer repository: `YishenTu/claudian`
- Selected producer ref: `origin/main`
- Observed producer revision: `c0522e04ffc083e9e6bda15cfa8411d4784e2205`
- Producer pull request: `YishenTu/claudian#1132`
- Package: `@claudian/collab-protocol`
- Package version: `0.4.0`
- Wire protocol version: `4`
- Cloud binding version: `1`
- Operation count: `15`
- Pack command: `npm pack --json --pack-destination <cloud-server>/vendor`
- Artifact: `claudian-collab-protocol-0.4.0.tgz`
- SHA-256: `e45d8cbe8b4d7558f66547acf5ad6c74bfc1362226a4642562c2d707c25786b1`
- Integrity: `sha512-4IDJr55ohdCcgn/RLpMghevuUxf5vwc3VIEgJr5HowzbmGuUNpGjHbn4wuMkOXGKBD0lvm85D4du5Sfwq8OfbQ==`

Producer verification on 2026-08-21 passed 14 protocol suites and 131 tests plus the complete 8,258-test Claudian application suite. The exact merged commit passed compatibility verification and clean packed-consumer verification with a 34-file inventory, CommonJS and ESM loading, and blocked package subpath imports. Cloud must retain these exact bytes until the mandatory pre-step-9 npm publication and clean-registry verification replaces the file dependency.
