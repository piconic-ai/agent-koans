---
'agent-koans': minor
---

Add koan 086: two invocations of one parallel batch are open when the process dies, one already answered and one in flight. Every crash koan until now left the repair a single thing to do, so "what it owes is read off the record, never counted" (SPEC.md §3) was only ever exercised one closure at a time. The recorded call must keep its answer while the interrupted one closes with an unknown outcome, and neither may be invoked again. The bundled Flue example loses the recorded member and is skipped with a reason.
