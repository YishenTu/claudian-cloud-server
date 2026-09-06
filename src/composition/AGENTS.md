# Composition

- Resource construction and disposal belong to the same visible owner. Startup failure and shutdown must reach every constructed owner; one hung close must not consume an unbounded budget or prevent later owners from receiving close.
- Complete locally actionable recovery and verify the database/volume pair, retained key references, and active repositories before readiness. A transfer waiting for external proof may remain fenced in its recovery catalog; it must not be treated as completed or reopened.
- Advertise a lifecycle capability only when its control, streaming, recovery, expiry, and shutdown dependencies are all composed. An offline recovery command does not imply online capability support.
- Run initial reconciliation before readiness. Start periodic work only after successful HTTP admission and readiness, and close its admission before disposing the storage it uses. Transaction timestamps, not timer execution, determine semantic expiry.
- Environment restore and Project recovery have separate policy owners. Composition may invoke them but cannot interpret their phases or register environment restore as Project recovery.
