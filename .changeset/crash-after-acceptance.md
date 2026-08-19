---
"agent-koans": minor
---

A `when:` trace may now open with `- crash` — the agent's process killed right after its run's acceptance, before any model exchange. Add koan 075, which pins that the acceptance alone is enough record to recover from: the restarted process must still resolve the run and drive it to the answer it was always going to give. SPEC.md §3 now also states what a crash does to a model request that was in flight and unanswered at the death: the recovered process asks again from the recorded history, as recovery rather than retry.
