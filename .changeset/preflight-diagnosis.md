---
"agent-koans": minor
---

The CLI diagnoses a broken `--agent` before the suite runs: it starts the agent once, and when the process dies or never answers `GET /health`, it reports the exit code, the captured output, and the likely cause — instead of failing every koan with the same startup timeout.
