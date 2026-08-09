# agent-koans

## 0.3.0

### Minor Changes

- 83c4b7c: Two koan-format extensions, each with a new tool-reliability koan. A tool-call instruction's `args` MAY now be a string — the verbatim wire `function.arguments` — so a koan can script malformed JSON that the agent must refuse before it ever reaches the tool server (`014-malformed-arguments`). A `request: model` step's `response` MAY now be a list of `{ tool, args }` instructions — one assistant message carrying multiple `tool_calls` — matched against the following tool requests unordered, by name and args (`015-parallel-tool-calls`).
- 06d6252: Runs can declare a model-request budget: `POST /runs` accepts `limits.max_model_requests`, and SPEC rule R5 now requires an agent to stop at a declared budget and end the run as `aborted`. The new koan `lifecycle/016-model-request-budget` verifies the boundary with a model that never converges, accepting both the thrifty process (skip the last instructed tool call) and the boundary-checking one (finish it, then stop).
- 362bdfe: The CLI diagnoses a broken `--agent` before the suite runs: it starts the agent once, and when the process dies or never answers `GET /health`, it reports the exit code, the captured output, and the likely cause — instead of failing every koan with the same startup timeout.

## 0.2.0

### Minor Changes

- 65a7d39: An optional agent-koans.yaml configures the suite: `add` runs your own koan directories alongside the bundled ones (their ids get the directory's name as a prefix and are tallied separately), and `skip` maps a koan id to a mandatory reason, printed with every skip. The CLI picks the file up from the current directory or via `--config`, and `--help` renders a real help screen.
- 21b3552: New SPEC rule R8 with a koan: a non-retryable model API failure (a 4xx other than 408 or 429) must end the run as failed, without re-issuing the request.
- 21b3552: New tool-reliability koans: a tool with an empty input schema, tools the model never uses, and giving up after persistent 5xx failures. The runner's test discovery is limited to this repository's own test/ directory.

### Patch Changes

- 65a7d39: Releases are cut from CI: merging the release PR publishes through npm trusted publishing (OIDC), pushes the vX.Y.Z tag, and creates the GitHub release from the CHANGELOG entry.
- 65a7d39: The README shows npm version, CI, and license badges.
