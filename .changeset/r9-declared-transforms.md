---
"agent-koans": patch
---

Correct R9. It said an agent may never coerce a tool-call argument, which contradicted `009-scalar-mismatch` — a koan that accepts coercion as one of two legitimate routes. The rule now says what the suite actually verifies: arguments pass through unchanged, except along a route a koan scripts explicitly.
