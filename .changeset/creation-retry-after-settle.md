---
'agent-koans': minor
---

Add koan 090: the caller names the run, never sees its acceptance, and re-sends the identical creation after the run has already settled. SPEC.md §3 pinned the idempotent creation resend only while the run was still working (koan 066) — a caller retrying an identical creation once it had already committed a result was never exercised, and an implementation whose duplicate-creation short-circuit only covers a still-running run passes the whole suite. The resend must land on the same run: the same acceptance, the same run_id, and the committed result stays untouched — the same idempotence 019/070 already pin for a late abort.
