---
"agent-koans": minor
---

Add `- retry: abort`, scripted right after `- abort`: the caller's abort delivered a second time once the run has settled from the first. Koan 070 pins a sentence SPEC.md already stated but no koan verified — repeated aborts are idempotent — checking that the second delivery is still accepted and does not rewrite the committed result.
