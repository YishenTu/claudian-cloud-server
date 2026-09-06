# Environment maintenance

- Maintenance commands adapt operator input to existing owners. They cannot create Project authorization, infer deletion intent, or become a second Project lifecycle dispatcher.
- Environment backup drains canonical lifecycle recovery before enumerating active and terminal Projects. External-proof waiting, unknown recovery, or dependency failure aborts the backup; an incomplete lifecycle must not silently remove a Project from its inventory.
- Capture and restore both active Project checkpoints and terminal-only continuity. Terminal claims and replay records cannot be reconstructed by inventing an active Project or placement. A published catalog is not a verified backup until isolated restore, repository integrity, and representative continuity reads pass.
- Clean restore starts with empty PostgreSQL and authority storage while ordinary admission is closed. One private environment journal is paired with database/volume identities; neither partial storage nor the Project recovery catalog can substitute for it.
- Before `authority-published`, recovery may remove only exact restore-owned state. At or after publication, recover forward and keep readiness closed until the same journal verifies every active and terminal Project.
- Validate the complete catalog, retained key references, and live protected envelopes before creating target state. Key material comes from the separately mounted deployment keyring and never enters a backup.
- Runtime credentials enumerate and capture active/terminal Project state. Schema-creating restore work receives the separate migration credential; ordinary backup and authority verification do not.
- Export expiry re-enters each due Project through its export settlement owner. Filesystem delivery markers never grant cleanup authority or replace the journal.
