---
"agent-koans": minor
---

A trace may now script a second death: a bare `- crash` directly after a tool step answered `crash`, landing on the recovery's own first model request. Add koan 077, which pins that a third process reaches exactly the state a single death would have left it in — repairing a record must be idempotent, read off the record rather than counted, so no crash shape leaves a run half-repaired or repaired twice (SPEC.md §3).
