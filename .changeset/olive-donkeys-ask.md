---
'agent-koans': minor
---

The caller can ask a run to fold its conversation down, and a fold can be refused. `POST /runs/{run_id}/compact` is the new endpoint, and what it asks for is not what `context.compaction` governs: that setting says when an agent folds on its own, and `off` does not take the choice away from the caller. The fold must happen before the conversation's next model request and be reported like any other, so a client that offered the button can show what came of pressing it.

A fold that fails owes one thing: the caller must be told, and told with what the model endpoint said, so it can decide whether to ask again. A `failed` entry in the run's `events` must carry an `error` naming what went wrong, in your own words but carrying the status or the error body's own text. Nothing else follows from it. Whether the agent carries on — it may, while the window still has room for another request — or ends the run is its own business.

`030-compaction-on-request` scripts the ask: a run with compaction off, a conversation nowhere near its window, and a fold anyway because the caller asked. A koan writes the ask as `- compact` at the end of the turn the caller asks after, which is the same shape `abort` has and for the same reason: it is a caller's action at a moment only the end of a trace can name. The turn after it must open with the fold.

`031-compaction-failure` scripts the refusal, written where the summary would have been: `response: { status: 400, body: ..., compaction: failed }`. Since every answer to a refusal conforms, the koan writes them all at once. A turn of a `turns:` koan can now carry `one_of`, a mapping of variant name to that turn's own `when` and `then`. The caller's prompts stay written once, because they are the same whichever way the run goes; only the exchanges the agent produced branch. Each variant is one whole run, and an agent conforms by walking any one of them.

A fold may also sit straight after a refused one, which is an agent asking again for what it did not get. Everywhere else the rule is unchanged: a fold belongs at the start of a later turn, the one position where every implementation has run out of room to defer it.

Both bundled examples answer the ask, and they walk different branches of the refusal: `examples/vanilla-ts` ends the run, `examples/flue` carries on. `examples/flue` needed a route to the ask. Flue's own manual fold, `harness.compact()`, folds the invocation harness's conversation, not the agent's, so the example opens the agent's own conversation the way the runtime does — the `default` session of the `default` harness — and folds that.
