---
'agent-koans': minor
---

A fold can be refused, and the format can now say so. A koan writes the refusal where the summary would have been — `response: { status: 400, body: ..., compaction: failed }` — and what the run owes for it is one thing: the caller must be told, and told with what the endpoint said, so it can decide whether to ask again. A `failed` entry in the run's `events` must carry an `error` naming what went wrong, in your own words but carrying what the model endpoint answered with.

Nothing else follows from a refused fold. Whether the agent carries on — it may, while the window still has room for another request — or ends the run is its own business, so `031-compaction-failure` writes every answer at once. A turn of a `turns:` koan can now carry `one_of`, a mapping of variant name to that turn's own `when` and `then`. The caller's prompts stay written once, because they are the same whichever way the run goes; only the exchanges the agent produced branch. Each variant is one whole run, and an agent conforms by walking any one of them.

A fold may also sit straight after a refused one, which is an agent asking again for what it did not get. Everywhere else the rule is unchanged: a fold belongs at the start of a later turn, the one position where every implementation has run out of room to defer it.

`examples/flue` skips the new koan for the same reason it skips `030-compaction-on-request`: the fold this koan refuses is one the caller asked for, and Flue has nothing there for a caller to reach.
