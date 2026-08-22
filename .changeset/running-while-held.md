---
'agent-koans': minor
---

The suite now checks that a run reports `running` while its work is provably in flight. Whenever the mock holds a tool invocation open to deliver a mid-run prompt, a creation retry, or a scripted kill, the runner polls `GET /runs/{run_id}` at that moment — the one observation point that cannot race a settle — and fails the koan if the status is anything else. No koan was added: every koan that already holds an invocation open (027, 053, 054, 055, 066, 068, 070, and the crash koans) now pins this for free. A fold ask is deliberately not covered — the contract does not require a settled run to report `running` again for one.
