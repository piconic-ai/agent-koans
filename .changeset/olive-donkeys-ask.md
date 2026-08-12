---
'agent-koans': minor
---

The caller can ask a run to fold its conversation down. `POST /runs/{run_id}/compact` is the new endpoint, and what it asks for is not what `context.compaction` governs: that setting says when an agent folds on its own, and `off` does not take the choice away from the caller. The fold must happen before the conversation's next model request and be reported like any other, so a client that offered the button can show what came of pressing it.

`030-compaction-on-request` scripts exactly that — a run with compaction off, a conversation nowhere near its window, and a fold anyway because the caller asked. A koan writes the ask as `- compact` at the end of the turn the caller asks after, which is the same shape `abort` has and for the same reason: it is a caller's action at a moment only the end of a trace can name. The turn after it must open with the fold.

`examples/flue` skips the new koan. Flue folds an agent's main conversation only on its own `CompactionConfig`; `harness.compact()` compacts the harness's scratch conversation instead, so a caller asking for a fold has nothing to reach.
