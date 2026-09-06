# Request context

- Production accepts one `Authorization: Bearer <credential>` header with a client-generated credential encoded as 64 lowercase hexadecimal characters. Derive the principal as `vault-` plus SHA-256 of the credential's UTF-8 text, encoded as lowercase hex. This derivation is shared with the client and preserves durable Project bindings; do not substitute decoded bytes or an installation/device identity.
- The client owns credential generation and synchronization. The server retains derived principal bindings, not raw credentials. A new valid credential establishes an identity, not membership in an existing Project.
- Bind each HTTP request and WebSocket handshake independently, including on reused connections. Reject missing, duplicate, combined, or malformed Authorization values. Headers claiming identity or role and socket metadata cannot override the derived principal.
- Production composition must expose no assertion-provider injection that bypasses credential verification. The private-development adapter recognizes only its development actor assertion; all Project transports in one application use the same selected binding.
