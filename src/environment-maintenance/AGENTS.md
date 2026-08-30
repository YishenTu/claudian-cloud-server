# Environment maintenance

## Ownership

- This scope owns environment-wide offline lifecycle policy that cannot be authorized or recovered as one Project operation. It currently owns clean restore and the compiled maintenance command boundary.
- Project backup/export coordinators, Project deletion authorization, PostgreSQL mechanics, repository paths/Git execution, configuration decoding, composition, and deployment sequencing remain behind their owning ports.
- Operator commands adapt validated input to owning application services. They never create Project authorization, infer deletion intent, interpret Project journals, or become a second lifecycle registry.
- Export delivery expiry is operator-scheduled through the bounded `reconcile-exports` one-shot command. The command re-enters each due Project through the existing export settlement owner and never treats the filesystem marker as Project authority.

## Restore contract

- Clean restore accepts only an empty PostgreSQL environment and empty authority volume while ordinary runtime admission is closed.
- One private startup-readable environment journal owns `validated`, `database-created`, `coordination-imported`, `repositories-staged`, `pair-prepared`, `repositories-published`, `authority-published`, `verified`, and `completed`.
- Before `authority-published`, recovery may remove only exact restore-owned state. At or after publication, recovery is forward-only and readiness remains closed until the same journal verifies every Project and terminal responder.
- The journal is paired with the authority-volume marker and database authority identity. It never enters the Project recovery catalog or infers environment state from a partial database or directory.
- Restore validates the entire backup catalog, every retained claim-custody key reference, and every live protected transfer-claim, invitation, and claim-override envelope before creating target state. Private keys come only from the deployment-owned keyring mount and never enter the backup.
- An environment backup contains active Project checkpoints plus a separate canonical continuity artifact for each terminal-only Project. Verification and restore preserve both sets without synthesizing active Project state or repository placement, and operator-reported Project counts include both sets.
- Before enumerating active or terminal Projects, environment backup strictly drains the canonical lifecycle recovery catalog. A candidate still waiting for external proof, an unsupported recovery kind, or any recovery failure aborts the whole backup; enumeration never silently omits a post-relinquishment Project that has not yet activated its placement.
- Backup, authority verification, and restore accept only the current coordination schema. Backup and authority verification enumerate active and terminal Projects through ordinary runtime credentials; only clean restore receives the migration credential needed to create an empty current-schema target.

## Verification

- Use multi-Project real PostgreSQL/Git fault injection after every phase, including database/volume marker ambiguity, exact pre-publication cleanup, forward-only post-publication recovery, representative domain reads, exact refs/OIDs, and terminal claim redemption after restore.
