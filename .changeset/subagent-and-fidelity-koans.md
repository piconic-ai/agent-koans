---
"agent-koans": minor
---

Four new koans close gaps the delegation and argument-fidelity rules left unchecked. `023-undeclared-argument` verifies R9 for a field the tool's schema never declared: the schema being silent about it is not permission to drop it, so the tool request must still carry it unchanged. `025-parallel-delegation` verifies R10 and R11 together, for one model response that delegates to two subagents at once: both children run, the parent's next request carries both finals, and neither child's own intermediate values leak to the parent or to each other. `026-subagent-budget` verifies R5 across conversations: a delegate's model requests draw from the same `max_model_requests` budget as the main conversation, not a fresh one of its own. `027-workspace-read` verifies `given.files` read directly by the main conversation — the counterpart to `021-subagent-file-handoff`'s delegate path.

R1 now says which conversation it governs. It read as though every declared tool had to reach every model request of the run, including a delegate's; narrowing a subagent's tools is a design choice rather than a defect, so the rule is scoped to the conversation the run's prompt opened, and a koan asks only that a delegate can make the calls scripted for it.
