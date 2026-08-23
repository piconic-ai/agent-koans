---
'agent-koans': minor
---

Add koan 092: the run's only model request is refused and the run settles `failed`, then the caller sends a follow-up prompt. SPEC.md §3 has always said a prompt sent to a settled run re-opens it, but every `turns:` koan's intermediate turns had to settle `completed`, so an implementation whose re-open only covers completed runs — or one that re-opens a failed run by starting a fresh conversation — passed the whole suite. A failure seals nothing: the follow-up re-opens the same conversation, with the history the failed turn left behind, and the run completes. In the format, an intermediate turn may now end in a model API failure when it declares `then: status: failed`.
