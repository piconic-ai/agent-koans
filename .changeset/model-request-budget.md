---
"agent-koans": minor
---

Runs can declare a model-request budget: `POST /runs` accepts `limits.max_model_requests`, and SPEC rule R5 now requires an agent to stop at a declared budget and end the run as `aborted`. The new koan `lifecycle/016-model-request-budget` verifies the boundary with a model that never converges, accepting both the thrifty process (skip the last instructed tool call) and the boundary-checking one (finish it, then stop).
