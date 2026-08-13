---
'agent-koans': minor
---

The caller can ask a run to fold its conversation down, and a fold can be refused. `POST /runs/{run_id}/compact` is the new endpoint, and what it asks for is not what `context.compaction` governs: that setting says when an agent folds on its own, and `off` does not take the choice away from the caller. The fold must happen before the conversation's next model request and be reported like any other, so a client that offered the button can show what came of pressing it.

A fold that fails owes two things. The caller must be told it failed, as a `failed` entry in the run's `events`; an `error` beside it is welcome and never read by the suite, since the same failure said in two vocabularies is the same failure. And the run goes on or ends by the room left in the window, never by the fold's outcome: a refused fold leaves the conversation exactly as it was, so it changes nothing about what the agent may do next.

`030-compaction-on-request` scripts the ask: a run with compaction off, a conversation nowhere near its window, and a fold anyway because the caller asked. A koan writes the ask as `- compact` at the end of the turn the caller asks after, which is the same shape `abort` has and for the same reason: it is a caller's action at a moment only the end of a trace can name. The turn after it must open with the fold.

Two koans script the refusal, written where the summary would have been: `response: { status: 400, body: ..., compaction: failed }`. They differ in one number. `031-compaction-failure` refuses a fold with the conversation at 40000 of 100000, and the run answers the turn anyway. `032-compaction-failure-no-room` refuses one with the window full, and the run ends, because there is nothing left to ask the model with.

`examples/flue` needed a route to the ask. Flue's own manual fold, `harness.compact()`, folds the invocation harness's conversation, not the agent's, so the example opens the agent's own conversation the way the runtime does — the `default` session of the `default` harness — and folds that. It skips `032`: Flue does not treat a run's declared window as a limit, and no seam of its agent API sits between its loop and the request it makes next.
