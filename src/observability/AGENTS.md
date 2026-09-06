# Observability

- Serialize through an explicit field allowlist. A syntactically safe string is not necessarily safe provenance: never put user text or a dependency error into an allowed token field.
- Do not forward raw HTTP, PostgreSQL, Git, filesystem, or process exceptions, arbitrary objects, repository paths, exports, or request/response bodies to telemetry or public errors.
- Adding an event or field requires checking its source and proving sensitive values remain absent from every affected sink. Redaction after arbitrary serialization is not an adequate boundary.
