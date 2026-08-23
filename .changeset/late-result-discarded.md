---
'agent-koans': minor
---

Add koan 096: a tool's declared timeout is given up on, the model is told, and the server's real answer arrives anyway, after the give-up. Koan 069 pins the give-up itself but scripts a server that never answers at all, so it cannot see a "soft" give-up: one that reports the timeout on time but keeps the connection open, and feeds the body that later arrives to the model as a second result, passes koan 069 unchanged. Koan 096 scripts the answer that then arrives: it must reach no model request of the run and must not reopen the invocation it missed. SPEC.md's Tool timeout paragraph and openapi.yaml's `timeout_ms` now say so directly: given up means closed.
