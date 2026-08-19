---
"agent-koans": minor
---

Add koan 072: a tool's result comes back tens of kilobytes large, and the agent must forward it to the model whole. Nothing in SPEC.md said a size earns different treatment; it does now (§4) — a declared tool's result MUST NOT be truncated, summarized, or otherwise altered on its way to the model.
