# Resource admission

- Shared Git-child, stream, staging, and event admission belongs here. Routes and domain owners consume permits instead of adding independent counters for the same resource. PostgreSQL connection pools remain owned by coordination.
- Keep per-Project and read/write limits below their shared ceilings where those budgets support concurrent Projects. Do not let a faster caller bypass queued limits or consume capacity reserved for another operation class.
- Background backup, validation, and maintenance consume the same real Git and staging budgets as foreground work.
- Bound queue waits and transfer permit ownership explicitly across asynchronous handoffs. A permit arriving after cancellation still needs release; releasing a reservation cannot hide an in-flight child or stream.
