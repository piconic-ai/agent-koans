---
"agent-koans": patch
---

SPEC no longer requires the agent to send `OPENAI_API_KEY`. The mock LLM never authenticates a request, so the old "MUST be sent but is not validated" was a requirement nothing could check. The runner still sets the variable, because OpenAI-compatible clients commonly refuse to construct without a key — it is an environment fixture, not a contract line.
