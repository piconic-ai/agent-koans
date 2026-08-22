---
'agent-koans': minor
---

Add koan 089, and make "a model request in flight and unanswered at the death" a fact instead of a race. The runner used to fire a scripted kill as soon as the pre-crash exchanges were observed, without waiting for the doomed process's next request to reach the mock — measured, the kill in koan 075 landed before any request was sent. The crash gate already parks that request, so the runner now waits for its arrival before killing; what 075 and 077 describe is now exercised on every run. Koan 089 pins the sentence's other half with an exact budget: the run has precisely the two requests its answers need, dies with the second sent and unanswered, and must still complete — a restart that had charged the doomed request finds nothing left to ask with.
