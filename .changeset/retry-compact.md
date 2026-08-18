---
"agent-koans": minor
---

Add `retry: compact`, written beside `compact` on an ask that brings about a fold: the same ask, re-sent while the fold it brought about is still summarizing. Koan 071 states and checks a promise SPEC.md did not make before — an ask that lands while a fold is already running joins that one instead of starting a second — since until now nothing sent the same fold ask twice.
