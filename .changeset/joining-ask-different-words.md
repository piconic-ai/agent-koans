---
'agent-koans': minor
---

Add koan 093: a second fold ask with different words arrives while the fold the first ask brought about is still summarizing. Koan 088 pinned the identical resend — the joining ask's words reach the fold once, as written — but a differently worded joiner was never exercised, so an implementation that queued a second fold for the new words, or leaked them into the running one, passed the whole suite. Joining does not depend on the wording: one fold, one report, serves every ask that converged on it, and a joining ask's own instructions reach nothing — not the running fold, whose wording was fixed when it began, and not a second fold after it. In the format, `joined_by:` beside `compact:` scripts the differing ask, delivered while the fold's summarizing request is provably in flight, and its words are forbidden from every model request of the run.
