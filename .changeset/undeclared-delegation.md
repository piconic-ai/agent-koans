---
"agent-koans": minor
---

Add koan 073: the model delegates to a subagent name the run never declared. The agent must open no child conversation — the refusal is the delegation's outcome, and it must reach the parent's model the way an unknown tool call's does (004) — and the run must not end for it. `given.subagents`, once written, is now the run's complete roster: an entry may declare nothing beyond existence (`{}`), and a delegation naming a name outside the map compiles as refused instead of requiring a subagent block.
