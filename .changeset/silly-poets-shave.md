---
'agent-koans': minor
---

A caller asking for a fold can say what the summary must keep. `POST /runs/{run_id}/compact` takes an optional `{ "instructions": "..." }`, and those words must reach the request that summarizes, as they were written. Asking is a kind of prompting — the words are the caller's, and an agent may no more reword them than it may reword a prompt. They are a field of their own rather than a prompt because they are about the summary, not the task.

A koan writes the ask as the words themselves: `compact: "Keep every operator code verbatim."`, with `true` staying the form for an ask that says nothing about how. `033-compaction-instructions` scripts one, and the mock reads the summarizing request for the caller's words the way it reads any other request for what must be on the wire.

Both bundled examples carry them. `examples/vanilla-ts` writes its own summarizing prompt and appends them to it. `examples/flue` cannot: Flue's `session.compact()` takes no arguments and its summarizing prompt is the runtime's own, so the example attaches the words to the request instead, at the provider boundary it already owns.
