# Configuration

- Decode external configuration before constructing runtime owners. Reject unknown, inconsistent, or unsafe values instead of repairing them implicitly.
- Operator-adjustable limits belong here; protocol-owned limits and collaboration semantics do not become deployment options.
- Keep `private-development` an explicit development-only choice; never fall back to it when production credentials are absent or invalid.
- The claim-custody keyring is a separate read-only secret file, not an environment value or backup artifact. Its fixed runtime path is `/run/secrets/claudian_claim_custody_keyring`; preflight requires a regular non-symlink file owned by `10001:10001` with mode `0400`. Keep key material and identifiers out of failure diagnostics.
