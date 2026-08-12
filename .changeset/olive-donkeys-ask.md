---
'agent-koans': minor
---

The caller can ask a run to fold its conversation down. `POST /runs/{run_id}/compact` is the new endpoint, and what it asks for is not what `context.compaction` governs: that setting says when an agent folds on its own, and `off` does not take the choice away from the caller. The fold must happen before the conversation's next model request and be reported like any other, so a client that offered the button can show what came of pressing it.

`030-compaction-on-request` scripts exactly that — a run with compaction off, a conversation nowhere near its window, and a fold anyway because the caller asked. A koan writes the ask as `- compact` at the end of the turn the caller asks after, which is the same shape `abort` has and for the same reason: it is a caller's action at a moment only the end of a trace can name. The turn after it must open with the fold.

Both bundled examples answer the ask. `examples/flue` needed a route to it: Flue's own manual fold, `harness.compact()`, folds the invocation harness's scratch conversation, not the agent's, so the example opens the agent's own conversation the way the runtime does — the `default` session of the `default` harness — and folds that.
