---
'agent-koans': patch
---

Fix the suite demanding a run's tool definitions on a delegate's model requests. SPEC.md §4 requires them of the conversation the run's prompt opened and leaves what a delegate is given to the implementation, but the check ran on every conversation — so an implementation that briefs its delegates without the run's tools failed koans it conforms to (020, 024, 042, 043, 044, 050, 057, 058, 076). The check is now scoped to the run's own conversation.
