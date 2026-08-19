---
"agent-koans": minor
---

`turns:` koans may now script `- crash` between two turns — the agent's process killed after one turn settles and before the next prompt is sent. Add koan 074, which pins the contract: a prompt sent after the death lands on the same run, is accepted normally, and is answered from the recorded history.
