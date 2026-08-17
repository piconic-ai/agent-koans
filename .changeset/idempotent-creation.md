---
"agent-koans": minor
---

Add idempotent creation: the request may carry `run_id`, the caller's own name for the run. A later creation request naming the same run must not create a second one — it is answered with the same acceptance while the existing run carries on, so a caller that never saw its acceptance can safely re-send the identical request. Koan 066 re-sends the creation mid-run and checks it lands on the same run with a single conversation; traces gain the step `- retry: prompt` to script the resend.
