---
"agent-koans": minor
---

A bare `- crash` may now land inside a subagent block — the whole process dies mid-delegation, not just the child's. Add koan 076, which pins the contrast with an in-flight tool invocation (068): the child's conversation is part of the run's record, it resumes to completion, and the delegation closes with the child's real answer, never an unknown outcome.
