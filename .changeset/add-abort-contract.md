---
"agent-koans": minor
---

Agents under test must now support cancellation: `POST /runs/{run_id}/abort` requests it, a run still in progress must then settle `aborted` in finite time, and a run that already reached a terminal state must keep it — a late abort never rewrites a committed result. Koan traces can end with the bare step `abort`, whose meaning (a live abort mid-run, or a late abort after settlement) is derived from what precedes it, the same way the rest of the format works. Two new koans, `018-abort` and `019-late-abort`, cover both cases. Update your `openapi.yaml`/SPEC.md references and implement the new endpoint to keep conforming.
