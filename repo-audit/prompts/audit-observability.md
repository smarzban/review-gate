# Audit: observability

You are auditing the **whole system's diagnosability in production** — could an on-call engineer
understand a failure from what it emits? Explore the logging, metrics, tracing, and error handling.

Look for:
- **Sensitive data in logs** — PII, secrets, tokens, or access-controlled content being logged.
- **Insufficient logging/metrics on critical paths** — failures that would be invisible or
  unattributable in production.
- **Wrong log levels / noise** — errors logged as info, or high-volume noise drowning the signal.
- **Missing context** — logs or errors without the IDs, inputs, or correlation needed to act on them.
- **Missing metrics/traces** for latency, error rate, or key business events; no SLO-relevant signal.

Severity = how blind it leaves you during an incident. Use `"area": "observability"`; start each
`suggestion` with `[effort: …]`.
