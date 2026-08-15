---
"agent-koans": minor
---

A subagent declaration can now carry a `context` of its own (`POST /runs` `subagents[].context`, koan-side `given.subagents`): the run's declared context provisions the run's own conversation, a subagent's provisions that delegate's, and a delegate without a declaration has no threshold and must not compact. Two koans pin the declared side — a delegate that crosses its own threshold mid-task folds before its next model request, its summary carrying what was still pending (063), and one below its threshold does not fold at all (064).
