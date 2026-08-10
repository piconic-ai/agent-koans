# agent-koans

## 0.5.0

### Minor Changes

- a930a91: Agents under test may now delegate work to subagents. A model response can be a delegation instruction, `{ subagent: <name>, prompt: <briefing> }`, scripted in a koan trace by a following `- subagent: <name>` / `when:` block that describes the delegate's own conversation. A subagent name may be delegated to at most once per trace — a subagent conversation cannot be continued yet. `given.files` (path → content) now materializes into a new `KOAN_WORKSPACE` env var before the run, so a koan can hand the agent context to find on disk instead of over the wire — read with the agent's own internal tool, never the mock tool server. `POST /runs` gains `subagents: [{ name, description? }]`, and an implementation declares its own delegation wire vocabulary (the tool name and its agent/prompt argument keys) via a new `delegation` key in `agent-koans.yaml`. Two new koans — `020-subagent-briefing` and `021-subagent-file-handoff` — verify bidirectional isolation between conversations and internal file reads. Update your `openapi.yaml`/SPEC.md references and implement subagent conversations (§6.4) to keep conforming.
- 2186dcc: Agents under test may now receive a follow-up prompt on an existing run: `POST /runs/{run_id}/prompts` re-opens a settled run and continues its conversation, carrying every earlier turn's exchanges into the new one. A koan scripts this with a top-level `turns:` list — entries of `{ prompt, when, then }` — instead of a single prompt and trace; each turn is judged by its own `then` (defaulting to `{ status: completed }`), and the last turn's `then` is the run's final judgment. New koan `022-follow-up` covers it, passing against both `examples/vanilla-ts` and `examples/flue` with no skip needed.

  BREAKING: this release also flattens two vocabularies that had grown unnecessary nesting. `given.task` is gone; every koan now names its initial prompt with a top-level `prompt:` field instead (mechanically renamed across the whole bundled suite — no koan's meaning changed). `then.run.{status,output}` is now flat, `then.{status,output}`: the `run:` wrapper never grew a second occupant, since every other verification need turned out to belong to the trace itself. `POST /runs` follows the same flattening on the wire: the body is now `{ prompt, tools, subagents, limits }`, with no `task` envelope. Update your agent to read `prompt` directly from `POST /runs` and to implement `POST /runs/{run_id}/prompts`, and update any of your own koans (`given.task` → top-level `prompt`, `then.run.*` → `then.*`) to keep conforming.

## 0.4.0

### Minor Changes

- c988d24: Agents under test must now support cancellation: `POST /runs/{run_id}/abort` requests it, a run still in progress must then settle `aborted` in finite time, and a run that already reached a terminal state must keep it — a late abort never rewrites a committed result. Koan traces can end with the bare step `abort`, whose meaning (a live abort mid-run, or a late abort after settlement) is derived from what precedes it, the same way the rest of the format works. Two new koans, `018-abort` and `019-late-abort`, cover both cases. Update your `openapi.yaml`/SPEC.md references and implement the new endpoint to keep conforming.
- a061460: The bundled `koans/` directory is flat: koan files no longer sit inside a `lifecycle/` or `tool-reliability/` subdirectory, and a koan's id is now just its filename (e.g. `001-happy-path`, not `tool-reliability/001-happy-path`). Custom koan directories added via `add` are flat the same way — a subdirectory inside an added directory now fails the run with an error instead of having its koans silently go undiscovered. Update any `skip` entries in `agent-koans.yaml` to drop the old directory prefix, and move any nested koans in your own `add`-ed directories up to the top level.
- 4e1ee0e: New koan `017-partial-batch-failure`: in a parallel tool-call batch, one call succeeds and the other fails. Both calls must be closed with their own result, the failure must reach the model as a tool error, and the model's retry must target only the failed call — the agent must not re-invoke the call that already succeeded.

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
