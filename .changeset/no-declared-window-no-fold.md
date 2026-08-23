---
'agent-koans': minor
---

Add koan 095: the run declares no context, and the model reports heavy usage anyway. Pressure is not permission: with no declared window there is no threshold to cross, the conversation is carried as it stands, and no fold the caller never declared appears. The format previously rejected `used_tokens` on the run's own conversation without a declared window, so no koan could even script the pressure — an implementation folding at a house default under an undeclared window passed the whole suite. The koan caught exactly that in the bundled Flue example, whose undeclared-context conversation sat on the mock model's finite registered window and folded on its own once reported usage crossed it — its adapter now mounts the unbounded-window model the delegates already use.
