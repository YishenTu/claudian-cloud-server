# Application source

- Keep the application a modular monolith. Cross-module calls use explicit owning contracts; do not reach through an owner to its storage or transport implementation.
- Domain policy must not depend on concrete HTTP, PostgreSQL, process, or provider implementations. Persistence and transport contracts may carry domain facts without taking over their policy.
- A disconnect or process shutdown does not prove that a mutation failed. Preserve the operation's durable identity and recovery path after ambiguous progress.
