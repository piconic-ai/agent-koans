---
"agent-koans": minor
---

A `when:` trace may now end with `- abort` followed by `- crash` — the caller's abort accepted while the run is still working, then the agent's process killed before the run settled. Add koan 078, which pins that an accepted abort is durable intent: the restarted process must still settle the run `aborted`, never resuming the turn the abort cut off. SPEC.md §3's Abort paragraph now also states this: a death never rewrites an accepted abort, the way a late abort never rewrites a committed result.
