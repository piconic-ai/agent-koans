---
"agent-koans": minor
---

Add `given.limits.max_duration_ms`: a per-submission wall-clock budget, measured from a prompt's acceptance to the submission's terminal state. Exhausting it must end the run as `aborted`, and the budget is a ceiling — koan 065 holds a tool invocation open forever and checks the agent neither hangs past the budget nor gives up before it. Tool responses gain a third form, `never`, for the mock to accept an invocation and answer with silence.
