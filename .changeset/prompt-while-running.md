---
"agent-koans": minor
---

A prompt sent to a run that is still `running` is no longer out of scope. SPEC section 3 now says what your agent must do with it: accept it, and do not drop it — the run must reach a terminal state carrying an answer to it. Whether the prompt joins the turn already in flight or waits and runs as its own turn once that one settles is yours to choose, because frameworks answer this differently on purpose, and both answers keep the promise a user actually cares about. The new koan `027-prompt-while-running` scripts both processes and passes an agent that walks either.

Getting there deterministically needed one new piece of koan vocabulary: `intercept`, written on the tool step whose response the mock then holds open. The agent is blocked on that response, so the run is provably still running when the delivery lands and no model request is in flight — the timing the koan needs is a fact of the wire rather than a race the runner has to win. `intercept` sits on the tool step rather than beside it for the same reason `abort` sits beside a trace's steps: where a delivery belongs is then a property of the shape, not a rule to check.
