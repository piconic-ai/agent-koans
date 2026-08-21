---
'agent-koans': minor
---

Add koan 079: a tool answers with five fields at once, and every one of them must reach the model. Result fidelity was pinned only for single-value bodies until now — the suite looked for any one of a result's scalars, so an implementation that forwarded one field of several passed 072 and everything around it. A successful tool result is now held to all of its values, while a failure is still told either way, by status or by the body's own words (SPEC.md §1).
