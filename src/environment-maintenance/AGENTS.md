# Environment maintenance

## Ownership

- This scope owns environment-wide offline lifecycle policy that cannot be authorized or recovered as one Project operation. It currently owns clean restore and the compiled maintenance command boundary.
- Project backup/export coordinators, Project deletion authorization, PostgreSQL mechanics, repository paths/Git execution, configuration decoding, composition, and deployment sequencing remain behind their owning ports.
- Operator commands adapt validated input to owning application services. They never create Project authorization, infer deletion intent, interpret Project journals, or become a second lifecycle registry.

## Restore contract

- Clean restore accepts only an empty PostgreSQL environment and empty authority volume while ordinary runtime admission is closed.
- One private startup-readable environment journal owns `validated`, `database-created`, `coordination-imported`, `repositories-staged`, `pair-prepared`, `repositories-published`, `authority-published`, `verified`, and `completed`.
- Before `authority-published`, recovery may remove only exact restore-owned state. At or after publication, recovery is forward-only and readiness remains closed until the same journal verifies every Project and terminal responder.
- The journal is paired with the authority-volume marker and database authority identity. It never enters the Project recovery catalog or infers environment state from a partial database or directory.
- Restore validates the entire backup catalog and every live protected claim envelope plus referenced receipt key before creating target state. Private keys come only from the deployment-owned keyring mount and never enter the backup.

## Verification

- Use multi-Project real PostgreSQL/Git fault injection after every phase, including database/volume marker ambiguity, exact pre-publication cleanup, forward-only post-publication recovery, representative domain reads, exact refs/OIDs, and terminal claim redemption after restore.
