---
'agent-koans': minor
---

Add koan 082: a run declares `max_duration_ms`, and two prompts each spend most of one budget. SPEC.md §3 has always said the budget belongs to a submission and starts again at every prompt, but `max_duration_ms` never appeared alongside `turns:` in the suite — only the opening submission's window was ever driven, so an implementation measuring from the run's own beginning passed. The second turn now has the whole budget however long the first one took.
