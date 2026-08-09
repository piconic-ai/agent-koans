---
"agent-koans": minor
---

Two koan-format extensions, each with a new tool-reliability koan. A tool-call instruction's `args` MAY now be a string — the verbatim wire `function.arguments` — so a koan can script malformed JSON that the agent must refuse before it ever reaches the tool server (`014-malformed-arguments`). A `request: model` step's `response` MAY now be a list of `{ tool, args }` instructions — one assistant message carrying multiple `tool_calls` — matched against the following tool requests unordered, by name and args (`015-parallel-tool-calls`).
