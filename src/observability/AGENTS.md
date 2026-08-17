# Observability

- Use allowlisted serializers and sanitized domain errors. Raw dependency
  exceptions and arbitrary object serialization never enter logs, traces,
  metrics, or public errors.
- Never record file contents, diffs, comments, Ticket/request bodies, raw
  request or response bodies, credentials, ingress assertions, tokens, private
  keys, repository paths, process arguments containing content, or exports.
- Operational telemetry may use opaque Project and operation IDs, route
  templates, operation kinds, safe error codes, durations, byte counts, child
  resource use, queue/pool pressure, event lag, backup age, and restore time.
- Audit records bind accepted actor, optional device/session attribution,
  derived membership, Project, operation, and result. They never store caller
  credential material or treat device attribution as Project authority.
- Redaction tests capture transport, PostgreSQL, Git, filesystem, process, and
  shutdown failures and prove forbidden data is absent from every sink.
