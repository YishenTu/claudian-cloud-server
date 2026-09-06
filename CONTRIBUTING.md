# Contributing

Use the Node.js version in `.node-version`, npm, Git, and Docker Engine with the Compose plugin. Read [AGENTS.md](AGENTS.md) and the instruction file governing the area being changed.

```bash
npm ci
npm run verify:fast
npm run verify:postgres
npm run verify:git
npm run verify:deployment
```

`verify:fast` covers lint, types, protocol consumer contracts, application tests, capacity-model tests, deployment tests, and the production build. PostgreSQL and Git verification use real dependencies. Deployment verification builds and exercises the runtime container. Docker must be available for these checks; test helpers create isolated databases and temporary resources.

To run the complete persistent Compose provisioning/restart test explicitly:

```bash
CLAUDIAN_TEST_PERSISTENT_COMPOSE=1 node --import tsx --test tests/deployment/PersistentLocalComposition.test.ts
```

The optional client interoperability test is part of `DevelopmentBootstrapPersistence.test.ts`. Set both `CLAUDIAN_CLOUD_CLIENT_WORKTREE` to a Claudian checkout and `CLAUDIAN_CLOUD_CLIENT_TEST_FILE` to its client-owned Jest interoperability test path. That test receives `CLAUDIAN_CLOUD_LOCAL_GATE_DESCRIPTOR`, containing the isolated server endpoint, bootstrap manifest, seed repository path, and result-file path. The ordinary server test runs without a client checkout.

The `private-development` principal profile and bootstrap route are test interfaces. Release deployment uses Vault credentials and requires the operator's authenticated entry point. Do not infer production access behavior from the development adapter.

Put local investigation, benchmark reports, and disposable scripts in `.context/`. Shared wire changes and releases belong to the standalone protocol repository; consume a published exact package version here. See [.github/RELEASING.md](.github/RELEASING.md) for server releases.
