# Lens: privacy & data retention

You are reviewing this change for **privacy and data-lifecycle concerns only**. Given the diff and
the full file contents, focus on data the change stores, transmits, or logs:

- **Sensitive content:** does the change persist/transmit/log data that may contain PII, secrets, or
  access-controlled material (e.g. answers derived from role-gated documents)? Where, and in what
  form (plaintext? client-side? shared scope?).
- **Lifecycle / clearing:** is persisted data **cleared at the right boundaries** — logout/sign-out,
  session expiry, a different user on a shared device, a role/permission downgrade? Trace where it is
  written vs where (if anywhere) it is removed.
- **Retention:** is there an unbounded or indefinite store with no TTL, cap, or eviction?
- **Identifiers:** is PII (email, etc.) used as a key/label where an opaque id would do?

Only raise privacy/retention findings. Use `"area": "privacy"`. Severity reflects sensitivity of the
data and the size of the exposure.
