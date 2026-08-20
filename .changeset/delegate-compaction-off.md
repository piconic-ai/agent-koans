---
'agent-koans': minor
---

Add koan 087: a delegate is declared a window and told never to fold, and its conversation runs to 95000 of 100000. A subagent's `context` provisions its conversation the way the run's own does, and until now only the threshold half of that was exercised — 063 and 064 both declare a percentage, so an implementation that read `off` as "use the house default" passed. The delegate must carry its history as it stands.
