---
"agent-koans": minor
---

Add `timeout_ms` to tool declarations: how long the caller wants an invocation of that tool waited for. An invocation still unanswered at the declared timeout must be given up at the declared timeout — not sooner, and not later — with the failure reaching the model like any other tool failure; the run carries on instead of dying. Koan 069 holds an invocation open forever and checks both ends of the window; a tool's own timeout also becomes a second legitimate ender for `response: never`, so a trace may now continue past one. Without a declaration nothing changes: when to give up on a slow dependency stays the implementation's own choice.
