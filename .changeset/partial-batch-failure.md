---
"agent-koans": minor
---

New koan `017-partial-batch-failure`: in a parallel tool-call batch, one call succeeds and the other fails. Both calls must be closed with their own result, the failure must reach the model as a tool error, and the model's retry must target only the failed call — the agent must not re-invoke the call that already succeeded.
