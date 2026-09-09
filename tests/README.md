# Cross-repository authority transfer gate

With Node 24, Docker, Git, and dependencies installed in both checkouts, run from the server repository:

```bash
node --import tsx tests/helpers/AuthorityRoundtripGate.ts /absolute/path/to/claudian
```

The helper creates an isolated PostgreSQL database, repository volume, signing keys, and loopback Cloud application, then invokes the client's `CloudAuthorityRoundtripGate.test.ts` through its package test command. Both repositories consume the exact published protocol dependency. Cleanup runs after the client gate finishes or fails.

The gate moves one Project through three consecutive LAN → Cloud → LAN cycles in one client process. It checks authority generations, member identity, coordination data, Git commits, current LAN origins, and unpublished local files. It requires no operator configuration or live Vault. The client test is skipped in its normal suite unless `CLAUDIAN_AUTHORITY_TRANSFER_SERVER_URL` is supplied; this helper supplies its own isolated server URL.
