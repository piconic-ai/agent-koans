---
'agent-koans': minor
---

Add koan 088: the caller's fold ask carries instructions and is re-sent while the fold it brought about is still summarizing. SPEC.md §3 has said since 071 that a joining ask's own instructions do not reach the fold already running, but 071's ask carries none, so nothing exercised the sentence — an implementation whose join breaks specifically when instructions are present (treating an ask that says how as its own fold) passed the whole suite. The fold's instructions are also now counted in the summarizing request, not merely found, when a repeated ask converged on it: one fold carries one ask's wording, however many asks converged.
