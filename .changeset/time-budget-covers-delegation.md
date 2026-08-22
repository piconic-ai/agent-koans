---
'agent-koans': minor
---

Add koan 085: a run's wall-clock budget is spent inside a delegation, and the run must still end `aborted` when it expires. SPEC.md §3 says model requests, tool waits, delegations and folds all count against the budget, but koan 065 only ever spent it on a tool wait in the run's own conversation — an implementation that stopped the clock while a delegate worked passed. A subagent block may now end on an invocation nothing will answer when the run declares `max_duration_ms`, the same way the main conversation's trace may.
