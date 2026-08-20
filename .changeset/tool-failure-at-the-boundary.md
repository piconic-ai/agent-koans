---
'agent-koans': minor
---

Add koan 080: a declared tool answers 400 and sends nothing with it. SPEC.md §4 has always said a status of 400 or above is a failure, but no koan answered a tool invocation with exactly 400 — the lowest failing status in the suite was 404, so nothing told an implementation whose threshold starts one status too high. With no body to pass on, the status is the whole of what the model must be told, and the call is made once: a 400 is not the agent's cue to repair its own arguments and try again.
