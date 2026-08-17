# Onboarding

- Staging is isolated, expiring, and never an authoritative Project or normal
  traffic source. Only activation through Project authority can create a
  canonical placement.
- The initial `development/` flow is limited to the private two-device profile:
  the LAN Host is manually stopped, two trusted reports must match, staged Git
  and coordination state are validated, and failures clean up idempotently.
- Do not reuse the development assertion, LAN Host admission, invitation trust,
  or LAN Host-transfer bindings for production Cloud onboarding.
- Production LAN-to-Cloud onboarding remains absent until freeze proof,
  resumable upload, exact checkpoint, activation/cutover, rollback, client
  redirection, lost-response recovery, and split-authority prevention are
  decision-complete.
- A new onboarding profile must add its durable phase and cleanup contract to
  `ARCHITECTURE.md` before adding routes or persistent state.
