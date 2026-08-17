---
"agent-koans": minor
---

Stretch the terminal-state guarantee across a process crash. The runner may now kill the agent (SIGKILL) mid-run and restart the same command; the run must still reach a terminal state under the same `run_id`, recorded work must never be redone, and an in-flight invocation's unknown outcome must reach the model instead of being retried by the agent. Traces script the death as a bare `- crash` step between exchanges or `response: crash` on an in-flight tool invocation; koans 067 and 068 pin the two sides. `KOAN_STATE_DIR` joins the environment contract as the run's durable state directory, and a non-durable implementation records the crash koans in its skiplist with reasons — the skiplist is part of a conformance claim, not a footnote to it.
