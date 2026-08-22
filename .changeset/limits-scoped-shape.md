---
'agent-koans': minor
---

BREAKING: budgets in `given.limits` are now written under the scope they cover — `limits.run.model_requests` replaces `max_model_requests`, and `limits.prompt.duration_ms` replaces `max_duration_ms`. The two budgets never had the same scope: the request count spans the whole run and survives a crash, while the wall clock starts again at every prompt, and the old flat names sat side by side saying neither. The wire format (openapi.yaml), the koan format, and SPEC.md change together, and SPEC.md now says in one place why the scopes differ: a request count does not tick while the run sits idle between prompts, but a wall clock does. SPEC and koan prose also drop "submission" for "prompt", matching the endpoint the caller actually uses; koan 082 is renamed `time-budget-per-prompt`. Old flat keys are rejected at load time with a message naming the new shape.
