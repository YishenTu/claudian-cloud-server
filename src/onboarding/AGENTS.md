# Onboarding

- Staging is isolated, expiring, and never an authoritative Project or normal
  traffic source. Only activation through Project authority can create a
  canonical placement.
- The initial `development/` flow is limited to the private two-device profile:
  the LAN Host is manually stopped, two trusted reports must match, staged Git
  and coordination state are validated, and failures clean up idempotently.
- Before activation, the development actor may match only its own immutable attempt manifest/report. Only the source Host actor may begin, upload, activate, or cancel; either exact accepted actor may submit its own report and read bounded status. Ordinary Project admission takes over immediately at Cloud activation.
- Bundle upload admission is attempt-scoped and acquired inside the Project-authority state check. The process-local abort gate and PostgreSQL session fence cover repository staging; settlement owns closing, aborting, cross-process draining, publication, and cleanup ordering.
- Attempt state is exactly `collecting`, `validating`, `ready`, `activating`, `rejected`, `cancelled`, `recovery-required`, or `activated`. Onboarding owns comparison, staging, validation, expiry, and cancellation requests; Project authority alone owns activation/cancellation settlement and visibility.
- Do not reuse the development assertion, LAN Host admission, invitation trust,
  or LAN Host-transfer bindings for production Cloud onboarding.
- `production/` may own isolated LAN-to-Cloud artifact receipt, staging, expiry, and exact cleanup only. It does not authorize transfer, create claims, publish a repository, activate a Project, accept source relinquishment, or recover the Project lifecycle.
- A new onboarding profile must add its durable phase and cleanup contract to
  `ARCHITECTURE.md` before adding routes or persistent state.
