---
'agent-koans': minor
---

Add koan 084: a run that already settled `failed` is aborted, and must stay `failed`. SPEC.md §3 says a settled run keeps the state it settled on, and the suite pinned that for a run settled `completed` (019) and for one settled `aborted` (070) — never for `failed`, the outcome an implementation is most likely to treat as still open. A trace may now end with `- abort` after a model API failure: the refused conversation still stops there, but the caller aborting the failed run behind it is a late abort like any other.
