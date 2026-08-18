# agent-koans

## 0.13.0

### Minor Changes

- 7f8af4e: Add `- retry: abort`, scripted right after `- abort`: the caller's abort delivered a second time once the run has settled from the first. Koan 070 pins a sentence SPEC.md already stated but no koan verified — repeated aborts are idempotent — checking that the second delivery is still accepted and does not rewrite the committed result.
- e075e99: Add `timeout_ms` to tool declarations: how long the caller wants an invocation of that tool waited for. An invocation still unanswered at the declared timeout must be given up at the declared timeout — not sooner, and not later — with the failure reaching the model like any other tool failure; the run carries on instead of dying. Koan 069 holds an invocation open forever and checks both ends of the window; a tool's own timeout also becomes a second legitimate ender for `response: never`, so a trace may now continue past one. Without a declaration nothing changes: when to give up on a slow dependency stays the implementation's own choice.

## 0.12.0

### Minor Changes

- 843e6fe: Stretch the terminal-state guarantee across a process crash. The runner may now kill the agent (SIGKILL) mid-run and restart the same command; the run must still reach a terminal state under the same `run_id`, recorded work must never be redone, and an in-flight invocation's unknown outcome must reach the model instead of being retried by the agent. Traces script the death as a bare `- crash` step between exchanges or `response: crash` on an in-flight tool invocation; koans 067 and 068 pin the two sides. `KOAN_STATE_DIR` joins the environment contract as the run's durable state directory, and a non-durable implementation records the crash koans in its skiplist with reasons — the skiplist is part of a conformance claim, not a footnote to it.
- bb02c74: Add idempotent creation: the request may carry `run_id`, the caller's own name for the run. A later creation request naming the same run must not create a second one — it is answered with the same acceptance while the existing run carries on, so a caller that never saw its acceptance can safely re-send the identical request. Koan 066 re-sends the creation mid-run and checks it lands on the same run with a single conversation; traces gain the step `- retry: prompt` to script the resend.

## 0.11.0

### Minor Changes

- a11b7ea: A subagent declaration can now carry a `context` of its own (`POST /runs` `subagents[].context`, koan-side `given.subagents`): the run's declared context provisions the run's own conversation, a subagent's provisions that delegate's, and a delegate without a declaration has no threshold and must not compact. Two koans pin the declared side — a delegate that crosses its own threshold mid-task folds before its next model request, its summary carrying what was still pending (063), and one below its threshold does not fold at all (064).
- 7141ec2: Ten koans for complex workflows, 053–062: two prompts delivered mid-run are answered in admission order (053); an abort clears the queued prompt (054) and stops a delegation mid-task (055); a delegate's model failure is the delegation's outcome, not the run's (056); a tool call and a delegation close as one parallel batch (057); delegation nests, with isolation at every depth (058); a second threshold crossing folds again (059); a delegate's usage never triggers the run's fold (060); the summarizing request spends from the model-request budget (061); and a severed tool connection reaches the model as a failure (062). Koan files can now script what these need: several mid-run prompts, `abort` after a delivered prompt or mid-delegation, a model API failure inside a subagent block, `response: disconnect` on a tool step, a fold as a trace's last exchange, a fold answered by more than one summarizing request (`response.body` as a list), and a per-turn `one_of` inside `turns:` koans for a `compact:` turn whose request count is an implementation's own choice.
- 92d944e: Add `given.limits.max_duration_ms`: a per-submission wall-clock budget, measured from a prompt's acceptance to the submission's terminal state. Exhausting it must end the run as `aborted`, and the budget is a ceiling — koan 065 holds a tool invocation open forever and checks the agent neither hangs past the budget nor gives up before it. Tool responses gain a third form, `never`, for the mock to accept an invocation and answer with silence.

## 0.10.0

### Minor Changes

- 4899fe0: A koan now writes the agent executing a call with a tool of its own as the request it is, with no response: `- request: { tool: read_file }`. A step's response is what a mock answered, and nothing observable answers this one — the file is in `given.files`, and what must surface is its content in the conversation's next model request. Three shapes now carry three meanings: a request with a response ran at the tool server, a request alone the agent answered itself, and no step at all is a call never executed. Before, the internal execution was an absence too, told apart from a refusal only by whether `args.path` named a `given.files` entry; a koan that still leaves an internal read to an absence is rejected at load time with the step to write, and a declared tool's request without a response is rejected naming the response it owes. The published koans 021 and 026 are rewritten in the new form; their contracts and every pass/fail outcome are unchanged.
- 870d731: Nineteen new koans, covering ordinary cases the suite stated only through their failures.

  Arguments: an optional field left out of a call, a number and a boolean, and an object argument whose fields the schema never describes — all three must reach the tool as the model wrote them (034–036).

  Tool failures: a 429 and a failure with no body at all, where the status is the only thing the model can be told (037–038).

  Parallel batches: the same tool called twice in one group, a batch whose calls all fail, and a group of three (039–041).

  Delegation: a delegate that answers without a tool, a tool failing inside a delegate, and a second delegate briefed after the first has answered (042–044).

  Budgets and the model endpoint: a model converging on the last request the budget permits, and a model request refused midway through a run (045–046).

  The workspace: a read sharing one parallel group with a declared tool, and two files read one after the other (047–048).

  Later turns: a third turn carrying both earlier ones, and a follow-up turn that delegates (049–050).

  Compaction: a declared threshold the conversation stays below, and a caller asking for a fold there anyway (051–052).

## 0.9.0

### Minor Changes

- 747e784: A caller asking for a fold can say what the summary must keep. `POST /runs/{run_id}/compact` takes an optional `{ "instructions": "..." }`, and those words must reach the request that summarizes, as they were written. Asking is a kind of prompting — the words are the caller's, and an agent may no more reword them than it may reword a prompt. They are a field of their own rather than a prompt because they are about the summary, not the task.

  A koan writes the ask as the words themselves: `compact: "Keep every operator code verbatim."`, with `true` staying the form for an ask that says nothing about how — the plain button, which leaves the wording to the agent. `033-compaction-instructions` scripts one, and the mock reads the summarizing request for the caller's words the way it reads any other request for what must be on the wire.

  Both bundled examples carry them. `examples/vanilla` writes its own summarizing prompt and appends them to it. `examples/flue` cannot: Flue's `session.compact()` takes no arguments and its summarizing prompt is the runtime's own, so the example attaches the words to the request instead, at the provider boundary it already owns.

## 0.8.0

### Minor Changes

- aa01ba0: The caller can ask a run to fold its conversation down, and a fold can be refused. `POST /runs/{run_id}/compact` is the new endpoint, and what it asks for is not what `context.compaction` governs: that setting says when an agent folds on its own, and `off` does not take the choice away from the caller. The fold has happened by the time the ask is answered, and is reported by then, so a client that offered the button can show what came of pressing it, and may send the next prompt at once.

  A fold that fails owes two things. The caller must be told it failed, as a `failed` entry in the run's `events`; an `error` beside it is welcome and never read by the suite, since the same failure said in two vocabularies is the same failure. And the run goes on or ends by the room left in the window, never by the fold's outcome: a refused fold leaves the conversation exactly as it was, so it changes nothing about what the agent may do next.

  `030-compaction-on-request` scripts the ask: a run with compaction off, a conversation nowhere near its window, and a fold anyway because the caller asked. An entry of a `turns:` koan is now something the caller did and what the agent did about it, which a prompt was already and the ask is too. An ask is written `compact: true` with the fold it brings about beneath it — a fold is an ordinary model request with a purpose, `request: { type: model, purpose: compaction }` — and nothing else, since without a prompt there is no other work. The prompt that follows is an entry of its own, and its first request is the one that must carry the summary.

  A prompt entry may also script no exchange at all, by leaving out its `when`: a caller can send a prompt the agent answers with no model request, which is what a full window leaves it.

  Two koans script the refusal, written where the summary would have been: `response: { status: 400, body: ..., compaction: failed }`. They differ in one number. `031-compaction-failure` refuses a fold with the conversation at 40000 of 100000, and the run answers the turn anyway. `032-compaction-failure-no-room` refuses one with the window full, and the run ends, because there is nothing left to ask the model with.

  `examples/flue` needed a route to the ask. Flue's own manual fold, `harness.compact()`, folds the invocation harness's conversation, not the agent's, so the example opens the agent's own conversation the way the runtime does — the `default` session of the `default` harness — and folds that.

  It also had to enforce the declared window itself: Flue treats a refused fold as best-effort and asks the model again, so the example stops that request at the provider boundary, where its request budget was already enforced.

- f78e320: Context pressure is now part of the contract. A run may declare the model's context window and the share of it at which the agent compacts — `POST /runs` gains `context: { window, compaction: { at_percent } }` — and a koan declares the same thing as `given.context: { window, compaction: 90% }`. Where a run declares no threshold, and where it declares no context at all, the agent must not compact, which is what every koan written before this one silently assumed and SPEC.md now says. Where it declares one, the size to compare against is the last `usage.prompt_tokens` the model endpoint reported for that conversation, and the fold must have happened by the time the conversation's next turn issues its first model request.

  A fold is also reported to the caller. `GET /runs/{run_id}` gains `events`, an append-only list, and a fold appends `{ type: "compaction", phase: "started" }` when it begins and one `completed` or `failed` when it ends. Without it a client cannot tell its user why the run went quiet, or why something it was told earlier is gone from the conversation.

  Whether to compact is the caller's setting, not the agent's own policy, so the suite verifies both positions of it. `028-context-compaction` fills the window past the threshold in one turn and requires the next turn to open on a folded conversation: one extra model request, answered with a summary, and that summary carried back in with what the task still needs. `029-compaction-off` scripts the same pressure with compaction off and requires the conversation to be carried as it stands.

  Where inside a turn the fold happens is deliberately left open, because implementations differ on purpose: some compact before the running turn's next request, some once the turn settles. Both conform, so a koan writes the fold as a model request with `purpose: compaction` — which is what it is — and may write it only at the start of a later turn, the one position where every implementation has run out of room to defer it. Its response carries everything the fold produced: `body` is the summary served to it, `used_tokens` is what the conversation shrank to, and `compaction: completed` is how the run reported the fold's ending to its caller. The request itself is the fold beginning, so only its ending is written.

  A step's request and response now each take details of their own, written inside: `request: { type: model, purpose: compaction }`, `response: { body: ..., used_tokens: 95000 }`. Both keep the plain form — `request: model`, `response: "the answer"` — for the steps that need no detail, which is most of them, so no koan written before this one changes.

## 0.7.0

### Minor Changes

- c199a82: A prompt sent to a run that is still `running` is no longer out of scope. SPEC section 3 now says what your agent must do with it: accept it, and do not drop it — the run must reach a terminal state carrying an answer to it. Whether the prompt joins the turn already in flight or waits and runs as its own turn once that one settles is yours to choose, because frameworks answer this differently on purpose, and both answers keep the promise a user actually cares about. The new koan `027-prompt-while-running` scripts both processes and passes an agent that walks either.

  Getting there deterministically needed one new piece of koan vocabulary: a `prompt` written on the tool step whose response the mock then holds open. The agent is blocked on that response, so the run is provably still running when the prompt arrives and no model request is in flight — the timing the koan needs is a fact of the wire rather than a race the runner has to win. It sits on the tool step rather than beside it for the same reason `abort` sits beside a trace's steps: where the prompt belongs is then a property of the shape, not a rule to check.

### Patch Changes

- aa45cfd: SPEC.md stops keeping its own copy of the contract. R1–R11 read as a second normative text beside the koans, and twice in one week the two disagreed — once forbidding a coercion `009-scalar-mismatch` accepts, once demanding a delegate see every declared tool. The requirements section is gone; section 4 now describes only the model wire, and section 5 carries a table of every koan and the contract line it states, generated from `koans/` by `pnpm koan-index` and checked by a test, so the one overview of the contract cannot drift from it.

## 0.6.0

### Minor Changes

- 141223d: Four new koans close gaps the delegation and argument-fidelity rules left unchecked. `023-undeclared-argument` verifies R9 for a field the tool's schema never declared: the schema being silent about it is not permission to drop it, so the tool request must still carry it unchanged. `024-parallel-delegation` verifies R10 and R11 together, for one model response that delegates to two subagents at once: both children run, the parent's next request carries both finals, and neither child's own intermediate values leak to the parent or to each other. `025-subagent-budget` verifies R5 across conversations: a delegate's model requests draw from the same `max_model_requests` budget as the main conversation, not a fresh one of its own. `026-workspace-read` verifies `given.files` read directly by the main conversation — the counterpart to `021-subagent-file-handoff`'s delegate path.

  R1 now says which conversation it governs. It read as though every declared tool had to reach every model request of the run, including a delegate's; narrowing a subagent's tools is a design choice rather than a defect, so the rule is scoped to the conversation the run's prompt opened, and a koan asks only that a delegate can make the calls scripted for it.

### Patch Changes

- fbda226: Correct R9. It said an agent may never coerce a tool-call argument, which contradicted `009-scalar-mismatch` — a koan that accepts coercion as one of two legitimate routes. The rule now says what the suite actually verifies: arguments pass through unchanged, except along a route a koan scripts explicitly.

## 0.5.1

### Patch Changes

- ecf02ed: SPEC no longer requires the agent to send `OPENAI_API_KEY`. The mock LLM never authenticates a request, so the old "MUST be sent but is not validated" was a requirement nothing could check. The runner still sets the variable, because OpenAI-compatible clients commonly refuse to construct without a key — it is an environment fixture, not a contract line. The same section now scopes tool execution to the tools a run declares, matching R7 and the internal-capability rules of §6.1 and §6.4.
- 7f62e4d: The koan file format's shape now lives in `src/koan-spec.ts` as plain types, one per YAML form, so a violation like mixing `when` with `turns` is unrepresentable rather than merely rejected. `src/parse.ts` reads a file into those types and checks the rules no type can carry (delegation and tool-request matching, budgets, distinct openings); `src/koan.ts` only compiles the result into the runner's internal form. `src/format.ts` is removed. No behavior change: every load-time error message is unchanged, and every bundled koan still loads and runs the same way. SPEC.md §6 now points to `src/koan-spec.ts` for the file's exhaustive shape, the way §3 already points to `openapi.yaml` for the wire format, and keeps its own prose to the overview and the verification semantics only a running trace can judge.

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
