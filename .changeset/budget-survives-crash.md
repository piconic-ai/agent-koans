---
'agent-koans': minor
---

Add koan 081: a run with a model-request budget spends half of it, the process dies between submissions, and the next prompt must find the budget where the death left it. No crash koan declared limits before this one, so nothing in the suite said what a restart does to a run's accounting — an implementation that armed a fresh budget on recovery passed everything. SPEC.md §3 now states it: what the run had already spent is recorded work like anything else, and the requests left after the death are the requests that were left before it. The bundled Flue example did re-arm from zero, and now resumes from the recorded count.
