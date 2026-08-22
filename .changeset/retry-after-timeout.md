---
'agent-koans': minor
---

Add koan 083: a declared tool is given up at its timeout, the model is told, and the model asks for the same call again. SPEC.md §3 says the follow-up after a timeout is the model's instruction rather than the agent's own retry, but koan 069 answers its timeout with a final reply, so no koan ever asked an implementation to make that instructed call. An agent that treats a timed-out tool as spent now fails.
