# agent-koans Conformance Contract

Version: 0.1.0-draft

agent-koans is a framework-agnostic conformance suite for AI agent
implementations. It verifies the *implementation* half of agent behavior —
argument validation, failure recovery, delegation, context handling,
termination — deterministically, with the model fully mocked. It does not
measure model capability; that is the job of evals.

This document is written for one reader: someone making an agent pass the
suite. It says what your agent must do. Two other files say things
precisely, and win wherever this one is vaguer than they are:

| File | Defines |
| ---- | ------- |
| [openapi.yaml](./openapi.yaml) | The wire format of your agent's HTTP interface |
| [src/koan-spec.ts](./src/koan-spec.ts) | What a koan file may contain |

An implementation conforms when it passes every koan in a released suite
version. Conformance claims MUST cite that version (e.g. "conforms to
agent-koans 1.x").

The key words MUST, MUST NOT, SHOULD, and MAY are to be interpreted as
described in RFC 2119.

## 1. How the suite runs your agent

Your agent is a black box behind an HTTP interface. The runner starts it
once per koan and watches it from both sides:

```
runner ───(1) POST /runs──────────▶ agent under test (black box)
                                        │
   mock LLM server ◀──(2) chat/completions──┤
   mock tool server ◀──(3) invoke/{tool}────┘
```

The mocks answer from a script the koan wrote, and record what your agent
sent them. Most of what the suite checks is that record: how many model
requests you made, what arguments reached a tool, what your conversation
carried at each step.

Checks on message content look for **the values the mock itself scripted**,
never for particular wording. When a koan wants to see that a tool failure
reached the model, it looks for the status code or the error body's own
text in the conversation you sent — so the phrasing of your errors is
yours, in any language, in any format.

## 2. Environment

The runner launches your agent with these environment variables:

| Variable          | Meaning                                                     |
| ----------------- | ----------------------------------------------------------- |
| `PORT`            | Port your agent MUST listen on                              |
| `OPENAI_BASE_URL` | Base URL of the mock LLM server (includes the `/v1` prefix) |
| `OPENAI_API_KEY`  | Dummy credential, for clients that require one to start     |
| `KOAN_TOOLS_URL`  | Base URL of the mock tool server                            |
| `KOAN_WORKSPACE`  | Path to the run's workspace directory                       |
| `KOAN_STATE_DIR`  | Path to the run's durable state directory                   |

All model calls MUST go to `OPENAI_BASE_URL`, and every invocation of a
tool the run declared MUST go to `KOAN_TOOLS_URL`. A capability of your
agent's own — delegating to a subagent, or reading a file — is executed
internally and MUST NOT reach the tool server.

`OPENAI_API_KEY` is set because OpenAI-compatible clients commonly refuse
to construct without a key. The mock never authenticates a request, so
whether you forward the value, send something else, or omit the header
entirely has no bearing on any koan.

`KOAN_WORKSPACE` always exists, even for a run whose koan puts no files in
it. It is a plain local directory, never reachable through the tool
server; a koan uses it to hand your agent context it must find on disk
rather than over the wire.

`KOAN_STATE_DIR` always exists too, and is empty when a koan starts. It
is the opposite of the workspace: not context the caller hands you, but
a place that is yours — a durable implementation keeps there whatever
must outlive its process. Across a scripted crash (§3) the restarted
process receives the same path; between koans it is fresh. An
implementation that persists nothing may ignore it.

## 3. Your HTTP interface

[openapi.yaml](./openapi.yaml) defines the endpoints, their schemas, and
their status codes. This section adds what a schema cannot say — what the
run's state must *do*.

| Endpoint | Purpose |
| -------- | ------- |
| `GET /health` | Readiness. `200` once you can accept runs |
| `POST /runs` | Submit a prompt, plus the run's tools, subagents, limits, and context settings |
| `GET /runs/{run_id}` | Poll the run's state |
| `POST /runs/{run_id}/abort` | Cancel a run |
| `POST /runs/{run_id}/prompts` | Continue a run's conversation |
| `POST /runs/{run_id}/compact` | Ask the run to fold its conversation down |

**Terminal state.** Every run MUST reach `completed`, `failed`, or
`aborted` in finite time — whatever the tools do, whatever the model
returns, whatever breaks inside you. A run still `running` past the
runner's timeout fails the koan.

**Naming the run.** The creation request MAY carry `run_id`
(openapi.yaml): the caller names the run instead of leaving the choice
to you. The acceptance MUST echo that name. A later creation request
carrying the same `run_id` MUST NOT create a second run: answer it with
the same acceptance — `201`/`202` and the same `run_id` — while the
existing run carries on undisturbed. This is what makes creation safe
to retry. A caller that never saw its acceptance sends the identical
request again, lands on the run it already started, and the model sees
one conversation, not two. What you do with a request that reuses a
`run_id` but changes the rest of the body is yours; the contract covers
the identical resend.

**Time budget.** A run MAY declare `given.limits.max_duration_ms`
(openapi.yaml): a wall-clock budget for one submission, measured from the
moment its prompt is accepted (that submission's own `202`/`201`) to that
submission's terminal state — model requests, tool waits, delegations,
and folds all count against it, and it restarts fresh for every prompt
the caller sends; time between submissions does not count. Exhausting it
before a final answer MUST end the run `aborted`, the same as any other
exhausted budget. A budget is a ceiling, not permission to stop early:
you MUST NOT settle a run `aborted` before its declared budget expires
just because one is declared. Where inside the window you give up on a
slow dependency is yours; no per-tool timeout is mandated unless the
run declares one (below).

**Tool timeout.** A declared tool MAY carry `timeout_ms` (openapi.yaml):
how long the caller wants an invocation of it waited for. An invocation
still unanswered at the declared timeout MUST be given up at the
declared timeout — not sooner, and not later: a declared wait is a
promise to wait, not only a bound on waiting. Giving up is not an abort
and not the run's failure: the timeout reaches the model the way any
tool failure does (§4), the follow-up call, if any, is the model's next
instruction — never your own retry — and the run carries on. Without a
declaration nothing changes; the sentence above stands.

**Crash recovery.** A koan may kill your agent's process — SIGKILL, no
warning — and start the same command again (a trace's `crash`). The
contract is the terminal-state guarantee stretched across the death: a
run whose prompt was accepted MUST still reach a terminal state, under
the same `run_id`, once a process is back. What was recorded before the
death MUST NOT be redone: a tool result already answered is not invoked
again, a model response already served is not requested again — the
conversation carries the recorded work forward as if the death had not
happened. Work in flight and never recorded has an unknown outcome, and
an unknown outcome reaches the model the way a tool failure does; the
follow-up call, if any, is the model's next instruction, never your own
retry. A model request in flight and unanswered at the death is the
opposite case: nothing of it was recorded and nothing of it reached the
conversation, so the recovered process asks again from the recorded
history. That is recovery, not a retry — a question that was never
answered cost nothing and changed nothing.
A delegation in flight is not a tool invocation: nothing of it left
the process, so nothing about it is unknown. The child's conversation
is part of the run's record — what it had recorded survives the way
the run's own does, the child resumes to completion, and the
delegation closes with the answer the child was always going to give,
never with an unknown outcome.
`KOAN_STATE_DIR` (§2) is where you keep whatever this takes.
The death may also fall between submissions: a prompt sent after the
restart MUST land on the same run and be answered from its recorded
history, the way any follow-up is (below) — a recovered run is never a
wedged one.
The death may also land on the recovery itself, and what a recovery
wrote is recorded work like any other: the closure it gave an
interrupted invocation is final, so a later death MUST NOT lead you to
invoke that call again behind it. Repairing a record is idempotent —
what it owes is read off the record, never counted — so a run killed
again while recovering reaches the state one death would have left it
in, never half-repaired and never repaired twice.
Only koans that script a `crash` exercise this; an implementation that
keeps its runs in memory records those koans in its skiplist, with
reasons (§6).

**Abort.** A run in progress MUST then settle `aborted`. An abort covers
everything of the run still unsettled: the turn in flight, a prompt
accepted but not yet answered, and a delegation mid-task all stop with
it — nothing may serve any of them afterwards. A run that has
already settled MUST keep the state it settled on: a late abort never
rewrites a committed result, and repeated aborts are idempotent. An
abort you accepted is durable intent: if your process dies before the
run settled, the run MUST still settle `aborted` once a process is
back — a death never rewrites an accepted abort, the way a late abort
never rewrites a committed result.

**Follow-up prompts.** A prompt sent to a settled run MUST re-open it:
`status` returns to `running`, the run reaches a terminal state again, and
`output` carries the new turn's answer. The conversation MUST carry every
earlier turn into this turn's model requests — verbatim, unless the run
asked you to compact and you folded them into a summary (below).

A prompt sent to a run still `running` MUST be accepted too, and MUST NOT
then be dropped: the run MUST reach a terminal state carrying an answer to
it. Whether it joins the turn already in flight, at that turn's next
boundary, or waits and runs as its own turn once that one settles, is
yours to choose — both conform, for each such prompt independently. A
queueing agent MAY report a terminal state in between, since that is the
earlier submission settling, and a prompt sent to a settled run re-opens
it. However they run, prompts form a queue: what the caller sent earlier
MUST NOT be answered after what it sent later.

**Delegation.** The subagents a run declares are available to every
conversation of the run — a delegate MAY delegate in turn, and what each
conversation may see of another holds at every depth: a briefing in, a
final answer out. A delegate whose own model request is refused loses
only the delegation: the refusal is the delegation's outcome and MUST
reach the conversation that delegated, the way a final answer would
have — what it means for the run stays that conversation's to decide. A
subagent declaration MAY carry a `context` of its own, provisioning that
delegate's conversation the same way the run's own provisions its. A
delegate the run declared no context for has no threshold and MUST NOT
compact. A delegate with a declared threshold that its conversation
reaches MUST have folded by that conversation's next model request — its
conversation ends at its final answer, so there is no settled turn to
defer to. A delegation naming a delegate the run never declared opens no
conversation: the refusal is the delegation's outcome and MUST reach the
conversation that delegated, the way a call to a tool that was never
declared does — what it means for the run stays that conversation's to
decide, and the run does not end for it. An implementation that wants
open-ended, on-demand delegation offers it the way real frameworks do: as
a general-purpose delegate under a declared name of its own, which a
caller names in `subagents` like any other — never by serving a name that
does not exist, which is a hallucination the model deserves to hear
about.

**Context.** A run MAY declare the context window its own conversation is
given, and the share of it at which the agent compacts — folds the
conversation into a summary and carries on from it. Where a run declares no
threshold, and where it declares no context at all, you MUST NOT compact.
Where it declares one, the size to compare against is the last
`usage.prompt_tokens` the model endpoint reported for that conversation, not
an estimate of your own — and each conversation's own: a delegate's usage
never stands in for the run's, however large it grows. Once that size
reaches the threshold, you MUST have compacted by the time the
conversation's next turn issues its first model request — whether you fold
it down before the running turn's next request, or once that turn settles,
is yours. Summarizing is an ordinary request to the same endpoint; what it
carries is yours to choose, its reply MUST reach the conversation it
summarized, and it draws from the run's model-request budget the way any
other request does. A fold MAY be served by more than one such request — how
many is yours too — and every one of their replies MUST reach the
conversation, however you combine them.

A fold MUST also be reported to the caller: an entry in the run's `events`
when it begins, and one when it ends saying whether it completed or
failed. A client that cannot see a fold cannot tell its user why the run
went quiet, or why something it was told earlier is gone from the
conversation.

**Asking for a fold.** `POST /runs/{run_id}/compact` is the caller asking
for one, and you MUST have folded by the time you answer it — and
reported the fold, completed or failed. A caller holding the answer knows
what came of pressing the button, and may send the next prompt at once.
The ask is not governed by `context.compaction`: that setting says when
you fold on your own, and `off` does not take the choice away from the
caller who asked.

An ask that arrives while a fold is already in progress MUST NOT start a
second one — it joins the fold already running, and you answer it the
same way: once that fold has ended and been reported. One fold, one
report, however many asks converged on it. A joining ask's own
instructions, if any, do not reach that fold: its wording was already
fixed when the fold it joins began.

An ask MAY carry instructions — what the caller wants the summary to keep
(openapi.yaml). Those words MUST reach the request that summarizes, as
they were written; an ask carrying none leaves the wording to you.

A fold that fails leaves the conversation as it was, and what decides
whether the run goes on is the room left in the window, never the fold's
outcome. With room, you carry on; with none, the run ends. What you owe
either way is a terminal state and a caller who was told.

## 4. Talking to the model

You reach the model at `POST {OPENAI_BASE_URL}/chat/completions`,
streaming (`stream: true`, SSE) or not, as your client prefers. When a run
declares tools, every request of the conversation its prompt opened MUST
carry function definitions for all of them; what a delegate is given is
your business. A tool call is answered with a `role: "tool"` message whose
`tool_call_id` matches it, and whatever the tool answered reaches the
model exactly as it came back — however large. Nothing here says a
size earns different treatment: a declared tool's result MUST NOT be
truncated, summarized, or otherwise altered on its way to the model.

You execute a declared tool at `POST {KOAN_TOOLS_URL}/invoke/{name}`, the
parsed arguments as the body. A status of 400 or above is a failure. So
is a connection severed before any answer arrived: nothing came back,
and nothing is not success.

What you do with any of this — when to invoke a tool, when to refuse one,
when to retry, when to give up — is the koans' business, below.

## 5. Koans

A koan is a YAML file: the world your agent is given, the exchange the
mocks will script, and the outcome expected of the run.
[src/koan-spec.ts](./src/koan-spec.ts) defines what such a file may
contain, and [koans/](./koans/) holds the suite.

```yaml
name: retry-on-transient-failure
description: >
  A transient 5xx must reach the model as a tool error, and the follow-up
  call must succeed without double-firing the tool.

given:
  tools:
    get_weather:
      input_schema:
        type: object
        properties: { city: { type: string } }
        required: [city]

prompt: "Get the current weather in Tokyo and report it."

when:
  - request: model
    response: { tool: get_weather, args: { city: "Tokyo" } }
  - request: { tool: get_weather }
    response: { status: 503, body: { error: "service_unavailable" } }
  - request: model
    response: { tool: get_weather, args: { city: "Tokyo" } }
  - request: { tool: get_weather }
    response: { status: 200, body: { temp: 31 } }
  - request: model
    response: "The weather in Tokyo is 31°C."

then:
  status: completed
  output: { contains: "31" }
```

Two things follow from that shape, and they are why most koans assert so
little explicitly:

- **The trace is the assertion.** A run must produce exactly the exchanges
  written — no more and no fewer. Its length is the call-count check, and
  the absence of a tool step after an instruction is the check that you
  did not invoke that tool.
- **Some koans accept more than one process.** Where a contract is about
  the outcome and more than one route legitimately reaches it, a koan
  scripts each route, and your agent conforms by walking any one of them.
- **What no koan scripts is open.** No koan answers a model request with
  408, 429, or a 5xx, because clients retry those on their own schedule
  and the trace would stop being deterministic. How yours behaves there
  is its own business.

### The suite

Every koan, in order, as each describes itself. This list is generated
from `koans/` by `pnpm koan-index`, and a test fails when it is stale, so
it cannot drift from the contract it indexes.

<!-- koan-index:start -->

| Koan | Contract |
| ---- | -------- |
| [000-plain-completion](./koans/000-plain-completion.yaml) | The agent forwards the task to the model and reports the final text. |
| [001-happy-path](./koans/001-happy-path.yaml) | One tool call that succeeds on the first try. The agent must invoke the tool with the model's arguments, feed the result back to the model, and report the final answer. |
| [002-arg-validation](./koans/002-arg-validation.yaml) | The model first calls the tool with arguments that violate the input schema (required "city" is missing). The agent must reject the call without invoking the tool — there is no tool request in the trace — report a validation error back to the model, and then execute the corrected call. |
| [003-retry-on-transient-failure](./koans/003-retry-on-transient-failure.yaml) | A transient 5xx must reach the model as a tool error, and the follow-up call must succeed. The agent must not retry on its own: one model tool call maps to at most one tool invocation. |
| [004-unknown-tool](./koans/004-unknown-tool.yaml) | The model first calls a tool that was never declared (a typo'd name). The agent must reject the call without invoking the tool server — there is no tool request in the trace — report the failure back to the model, and then execute the correctly-named call. |
| [005-wrong-arg-type](./koans/005-wrong-arg-type.yaml) | The model first calls the tool with an argument of the wrong primitive type ("city" must be a string, not an array). The agent must reject the call without invoking the tool — there is no tool request in the trace — report a validation error back to the model, and then execute the corrected call. |
| [006-permanent-client-error](./koans/006-permanent-client-error.yaml) | A permanent 4xx (the city does not exist) must reach the model as a tool error. Unlike a transient failure, there is no follow-up call to retry — the model gives up gracefully and reports it could not find the data. Exactly one tool invocation is made. |
| [007-multi-tool-sequence](./koans/007-multi-tool-sequence.yaml) | A task that requires two different tools in sequence. The agent must invoke each tool with the model's arguments, feed each result back to the model in turn, and only then report the combined final answer. |
| [008-repeated-calls](./koans/008-repeated-calls.yaml) | A task that requires the same tool twice with different arguments. The agent must invoke it once per city, feed each result back to the model in turn, and only then report the comparison. |
| [009-scalar-mismatch](./koans/009-scalar-mismatch.yaml) | The model sends "3" where the schema says number — a coercible scalar mismatch. Whatever the process, the user's expectation must be met: the tool ends up correctly invoked and the run completes. Two processes are acceptable: coerce the argument and invoke immediately, or reject it, report back, and let the model correct itself. |
| [010-empty-schema-tool](./koans/010-empty-schema-tool.yaml) | A tool whose input_schema declares an object with no properties. The agent must accept and correctly invoke it with empty arguments, not reject the call as if the schema demanded something. |
| [011-direct-answer](./koans/011-direct-answer.yaml) | Tools are offered but the model's first response is a bare text answer, with no tool call. The agent must not force tool use — no tool_choice coercion, no looping until a tool is called — and must report the answer as soon as the model gives one. |
| [012-give-up-on-persistent-5xx](./koans/012-give-up-on-persistent-5xx.yaml) | A 5xx tool failure must reach the model as a tool error, same as a 4xx. The model may give up instead of asking for a retry; unlike 003, there is no follow-up call. The agent must not retry on its own — exactly one tool invocation is made, and the run still completes. |
| [013-model-api-failure](./koans/013-model-api-failure.yaml) | The model endpoint rejects the request with 401. The agent must not re-issue it and must end the run as failed. |
| [014-malformed-arguments](./koans/014-malformed-arguments.yaml) | The model emits a tool call whose arguments are not valid JSON. The call must never reach the tool server; reported back, the model corrects itself. |
| [015-parallel-tool-calls](./koans/015-parallel-tool-calls.yaml) | The model requests two independent tools in one response (one assistant message, two tool_calls). The agent must invoke both — in any order, sequentially or concurrently — close each with its own tool message, and only then report the combined answer. |
| [016-model-request-budget](./koans/016-model-request-budget.yaml) | The run declares a model-request budget and the model never converges within it. The agent must not exceed the budget and must end the run as aborted. The tool call instructed by the last permitted response may be skipped or finished — both processes stay within the budget. |
| [017-partial-batch-failure](./koans/017-partial-batch-failure.yaml) | One call of a parallel batch succeeds and the other fails. Both must be closed with their own result, the failure reaching the model, and the model's retry must target only the failed call. |
| [018-abort](./koans/018-abort.yaml) | The caller aborts a run in progress. The agent must stop asking the world for anything and settle the run as aborted. |
| [019-late-abort](./koans/019-late-abort.yaml) | An abort that arrives after the run has settled must not rewrite the committed result. |
| [020-subagent-briefing](./koans/020-subagent-briefing.yaml) | The parent delegates one lookup to a subagent. The briefing is the child's whole world: the child must see only its briefing, and the parent must see only the child's final answer — none of the child's intermediate work. |
| [021-subagent-file-handoff](./koans/021-subagent-file-handoff.yaml) | Context crosses to a subagent through a file instead of the briefing. The child reads the named workspace file with the agent's own tool — the mock tool server is never involved — and the file's content must reach the child's next model request. |
| [022-follow-up](./koans/022-follow-up.yaml) | A follow-up prompt to the same conversation. The agent must carry the earlier exchange into the next turn. |
| [023-undeclared-argument](./koans/023-undeclared-argument.yaml) | The schema declares only "city", but the model's call also carries "units", a field the schema never mentioned. Dropping an argument the schema did not declare is forbidden: the tool request must carry both, unchanged, and the run completes normally. |
| [024-parallel-delegation](./koans/024-parallel-delegation.yaml) | One model response delegates to two subagents at once — a parallel group of delegations. Both children must run; the parent's next request must carry both finals, and neither child's own intermediate values — its tool results, distinguishable per child here — may reach the parent or the other child. |
| [025-subagent-budget](./koans/025-subagent-budget.yaml) | A delegate's model requests draw from the same budget as the main conversation, not a fresh one of its own. The budget is exhausted by the main request plus the child's two, right as the child answers — so the parent never gets to make its own next request to report that answer, and the whole run must end aborted. |
| [026-workspace-read](./koans/026-workspace-read.yaml) | The main conversation reads a workspace file directly, with no subagent involved. "read_file" names a tool the run did not declare, so it must not reach the tool server; its request carries no response, since the agent answers it itself, and the file's content must flow into the conversation's next model request and the final answer. |
| [027-prompt-while-running](./koans/027-prompt-while-running.yaml) | A second prompt is delivered while the run is still running — during a tool invocation the mock holds open, so the run provably has not settled. The agent must accept it, must not lose it, and must still settle with an answer to it. Two processes are acceptable, and the koan is silent about which: join the live conversation at the next turn boundary, or queue the prompt as its own turn once the first submission settles. Either way the held tool call is still closed. A delivery at any other moment of a run is not covered. |
| [028-context-compaction](./koans/028-context-compaction.yaml) | The run declares the model's context window and the share of it at which the agent compacts. The first turn fills the window past that share, so the second turn cannot open with the conversation as it stands: by its first model request the agent must have folded it into a summary — one extra model request, answered with one. The summary must come back into the conversation carrying what the second turn asks for, an operator code looked up before the fold, and the run must report the fold to its caller, who has a user to explain it to. Where inside the first turn the agent folds is not covered: before its next request, or once it settles. |
| [029-compaction-off](./koans/029-compaction-off.yaml) | The same pressure as 028, with compaction switched off. The conversation fills the declared window and the agent must leave it alone: no extra model request, no summary, the history carried as it stands — the trace has no compaction step for one to consume. Being nearly out of room is not itself a reason to end the run, which still completes. |
| [030-compaction-on-request](./koans/030-compaction-on-request.yaml) | The caller asks for a fold. The run declares compaction off, so nothing the conversation does would fold it — and it folds anyway, because being asked is not the same as crossing a threshold. By the second turn's first model request the conversation must be a summary, that summary must carry what the second turn asks for, and the run must report the fold to the caller who asked for it. |
| [031-compaction-failure](./koans/031-compaction-failure.yaml) | The caller asks for a fold and the summarizing request is refused, so nothing is summarized and the conversation stays as it was. Two things follow. The caller must be told the fold failed — not in any particular words, since a failure said two ways is the same failure, so what this koan reads is the report and never its wording. And the run carries on: the conversation is far from its window, and what decides whether the agent may ask the model again is the room left there, never the fold's outcome. |
| [032-compaction-failure-no-room](./koans/032-compaction-failure-no-room.yaml) | The same refusal as 031, against a full window: the same run, the same ask, the same refusal, and one number changed. The first turn leaves the conversation at the size the run declared, so when the fold the caller asked for is refused there is no room for another model request, and the run ends instead of making one. What the agent reads to know that is the size the model reported, against the window the run declared — never its compaction policy, which says only when it folds on its own. |
| [033-compaction-instructions](./koans/033-compaction-instructions.yaml) | The caller asks for a fold and says what it must keep. Asking is a kind of prompting: the words are the caller's, they are about the summary rather than the task, and an agent may no more reword them than it may reword a prompt. So the summarizing request must carry them, and the summary that comes back must reach the conversation the way any other fold's does. |
| [034-optional-argument-omitted](./koans/034-optional-argument-omitted.yaml) | The schema declares "units" but does not require it, and the model's call leaves it out. Optional means optional: the agent must invoke the tool with the arguments as the model wrote them — neither rejecting the call as incomplete nor filling the missing field in itself. |
| [035-non-string-arguments](./koans/035-non-string-arguments.yaml) | The call carries a number and a boolean, both matching the schema. The arguments must reach the tool with their JSON types intact: 3 stays a number and true stays a boolean, neither one turned into a string on the way. |
| [036-nested-object-argument](./koans/036-nested-object-argument.yaml) | One argument is an object of its own, whose fields the schema never describes. The agent must pass the whole structure through to the tool as the model wrote it — not flattened, not pruned to the fields the schema names. |
| [037-tool-rate-limited](./koans/037-tool-rate-limited.yaml) | The tool server answers 429. A rate limit is a tool failure like any other: it must reach the model, and the agent must not retry it on its own — the follow-up call is the model's, and it succeeds. |
| [038-tool-failure-without-body](./koans/038-tool-failure-without-body.yaml) | The tool server fails with a status and nothing else. There is no error text to pass on, so the status itself is what the model must be told — a failure the agent reports as a bare result would leave the model reading it as success. |
| [039-parallel-same-tool](./koans/039-parallel-same-tool.yaml) | One response requests the same tool twice with different arguments. The two calls are told apart by their arguments alone, so the agent must invoke the tool once per city — not once for the pair — and close each call with its own result. |
| [040-parallel-batch-all-fail](./koans/040-parallel-batch-all-fail.yaml) | Every call of a parallel batch fails. A batch is not abandoned because its first member failed: both calls must be made and both closed with their own failure, each reaching the model, which then gives up gracefully. |
| [041-parallel-three-calls](./koans/041-parallel-three-calls.yaml) | A parallel group of three, rather than the pair of 015. A batch has no size the agent may assume: all three calls must be invoked and closed before the model is asked again. |
| [042-subagent-direct-answer](./koans/042-subagent-direct-answer.yaml) | The delegate answers its briefing without calling anything. A subagent is not obliged to use a tool any more than the main conversation is (011): the child's first reply is its final answer, and it is what returns to the parent. |
| [043-subagent-tool-failure](./koans/043-subagent-tool-failure.yaml) | A tool fails inside the delegate. The failure is the child's to handle: it reaches the child's model and stops there, so the parent learns of it only through the child's final answer, and the run still completes. |
| [044-sequential-delegation](./koans/044-sequential-delegation.yaml) | Two delegations, one after the other, each in its own model response. The second child is briefed after the first has answered, and neither child may see the other's work: what crosses between them is only what the parent writes into the second briefing. |
| [045-budget-met-exactly](./koans/045-budget-met-exactly.yaml) | The run declares a model-request budget and the model converges on the last request the budget permits. A budget is a ceiling, not a quota to spend or a reason to stop early: the agent must make that last request and the run must complete with its answer. |
| [046-model-api-failure-midway](./koans/046-model-api-failure-midway.yaml) | The model endpoint rejects a request made in the middle of the run, after a tool call has already succeeded. Work already done is no reason to press on: the agent must not re-issue the request, must not invoke anything further, and must end the run as failed. |
| [047-workspace-read-in-a-batch](./koans/047-workspace-read-in-a-batch.yaml) | One response asks for a workspace read and a declared tool at once. A parallel group may mix the two kinds: the read is executed internally and never reaches the tool server, the declared call does reach it, and both must be closed before the model is asked again — an agent that runs the two kinds in separate rounds leaves one of them open. |
| [048-workspace-two-files](./koans/048-workspace-two-files.yaml) | Two workspace files, read one after the other. Each read must flow into the conversation's next model request, so the second read does not displace the first: the final answer is drawn from both files. |
| [049-three-turns](./koans/049-three-turns.yaml) | A third turn, where 022 has two. History does not thin out as it grows: the last turn's request must still carry both earlier turns, which is what lets the model answer from them without looking anything up again. |
| [050-follow-up-delegation](./koans/050-follow-up-delegation.yaml) | A follow-up turn delegates. The parent must carry its own earlier turn into this one, and the child must still see only its briefing: a conversation's history belongs to the conversation that holds it, and a delegate opens a new one however long the parent's has grown. |
| [051-compaction-below-threshold](./koans/051-compaction-below-threshold.yaml) | The run declares a threshold and the conversation stays well below it. A declared threshold is not an instruction to fold whenever convenient: with room left, the agent must carry the history as it stands into the next turn — the trace has no compaction step for one to consume. |
| [052-compaction-asked-below-threshold](./koans/052-compaction-asked-below-threshold.yaml) | The caller asks for a fold while the conversation sits far below the threshold the run declared. The threshold says when the agent folds on its own, and 051 shows it holding here; the ask is the caller's, and it folds the conversation anyway. |
| [053-two-prompts-while-running](./koans/053-two-prompts-while-running.yaml) | Two prompts are delivered while one turn is still running — one during each held invocation of a parallel batch, so both are accepted before either could be answered. Submissions form a queue: neither prompt may be lost, and their answers come in the order they arrived. Two processes are acceptable, and the koan is silent about which: both deliveries join the live conversation at its next turn boundary, or each waits and runs as its own turn, first-come first-served. |
| [054-abort-clears-the-queue](./koans/054-abort-clears-the-queue.yaml) | A second prompt is delivered while a tool invocation is held open, and the caller then aborts — the delivery is provably accepted and provably unanswered when the abort lands. An abort covers every submission still unsettled, the queued prompt included: the trace ends here, so no model request may serve that prompt afterwards, and the run settles aborted. |
| [055-abort-during-delegation](./koans/055-abort-during-delegation.yaml) | The caller aborts while a delegate is mid-task: the child's tool call has returned, and whatever the child asks for next goes unanswered. The abort stops the whole tree — the child does not press on to a final answer, the parent never hears one, and neither may ask the world for anything further. The run settles aborted. |
| [056-subagent-model-failure](./koans/056-subagent-model-failure.yaml) | The delegate's model request is rejected with 401. The refusal ends the child's conversation, but it is the delegation's outcome, not the run's: it must reach the parent's model as what came of the task — without the child's request being re-issued — and the parent still closes the run normally. 013 ends the run because the conversation that lost its model was the run's own; a delegate losing it loses only the delegation. |
| [057-delegation-in-a-batch](./koans/057-delegation-in-a-batch.yaml) | One model response asks for an ordinary tool call and a delegation at once. A parallel group may mix the two kinds, the way 047 mixes a workspace read with a declared tool: the call reaches the tool server, the delegate runs a conversation of its own, and both must be closed — the tool's result and the child's final answer both in hand — before the model is asked again. |
| [058-nested-delegation](./koans/058-nested-delegation.yaml) | A delegate delegates in turn. The subagents a run declares are available to every conversation of the run, and isolation recurses with them: the parent sees only the coordinator's final, the coordinator sees only the field lookup's final, and the station code the grandchild's tool returned reaches neither of the conversations above it. |
| [059-second-fold](./koans/059-second-fold.yaml) | The conversation crosses the run's threshold twice. Folding is not a once-per-run event: the second crossing owes the same fold, the same report to the caller, and the same carrying-forward that 028 shows for the first. What the second fold folds is the conversation as it then stands — the first summary and everything after it — so a code that only the first summary still carried must survive into the second, and from there into the final answer. How many requests that second fold costs is the implementation's own choice (SPEC.md §3): one-request and two-request (a history summary and a still-open turn's own, however the two requests order) shapes both conform. |
| [060-subagent-usage](./koans/060-subagent-usage.yaml) | A delegate's conversation grows to 95000 of the run's declared 100000 window — past the 90% threshold — while the parent's own stays small. The size a threshold is compared against is each conversation's own reported usage, never another conversation's of the same run: the child's growth is not the parent's, so the parent must not fold, and the next turn opens on the history as it stands — the trace has no compaction step for one to consume (051). |
| [061-fold-spends-the-budget](./koans/061-fold-spends-the-budget.yaml) | The summarizing request is an ordinary request to the model endpoint, so it draws from the run's model-request budget the way any other request does (016). A budget of 2 is spent by one reply and one asked-for fold; the follow-up prompt finds nothing left, and the run must end aborted without asking the model anything — the trace has no request left for it to make. |
| [062-tool-connection-drop](./koans/062-tool-connection-drop.yaml) | The tool server accepts the invocation and severs the connection without answering — no status, no body, unlike 038's bare status. There is nothing to pass on but the fact of failure, and that fact must reach the model rather than end the run: a transport failure is a tool failure like any other. The agent must not retry the invocation on its own — one call, one invocation — and the model gives up gracefully. |
| [063-delegate-mid-task-fold](./koans/063-delegate-mid-task-fold.yaml) | A delegate with a declared context crosses its own threshold in the middle of its task — on a tool-instruction response, with the batch it opened still unclosed. Its conversation ends at its final answer, so there is no settled turn to defer to: by the delegate's next model request the fold must have happened, its summary — carrying the result still pending — folded back in, and the fold reported to the run's caller like any other. The run itself declares no context at all: whose window a threshold reads is each conversation's own (060). |
| [064-delegate-below-threshold](./koans/064-delegate-below-threshold.yaml) | A delegate's conversation grows toward its own declared threshold but stays well below it: 30000, then 40000 of the declared 50000, short of the 45000 the delegate would fold at. A declared threshold is not standing permission to fold (051's contract line, now for a delegate): with room left, the delegate must carry its own history as it stands into its final answer — the trace has no compaction step for one to consume. The run itself declares no context at all: whose window a threshold reads is each conversation's own (060). |
| [065-time-limit](./koans/065-time-limit.yaml) | The run declares a wall-clock budget and the only tool the task needs never answers — no status, no severed connection, just silence. The agent must keep waiting while the budget lasts (a budget is a ceiling, not permission to stop early) and end the run as aborted once it expires, without a farewell model request. |
| [066-idempotent-creation](./koans/066-idempotent-creation.yaml) | The caller names the run (`run_id` in the creation request) and, never having seen its acceptance, sends the identical creation again while the run is still working. The resend must land on the same run — the same acceptance with the same run_id — and must not start a second conversation: one tool invocation, one answer. |
| [067-crash-after-recorded-result](./koans/067-crash-after-recorded-result.yaml) | The agent's process is killed without warning after a tool result was recorded, and started again. The run must pick up where the record ends, not where memory did: the caller's poll still resolves the same run, the next model request carries the recorded result, the tool is not invoked again, and the run completes with the same answer it was always going to give. Recorded work is never redone. |
| [068-crash-in-flight-invocation](./koans/068-crash-in-flight-invocation.yaml) | The agent's process is killed while a tool invocation is in flight — accepted by the tool server, not yet answered — and started again. Nothing was recorded, so the invocation's outcome is unknown, and an unknown outcome is the model's to hear about, not the agent's to guess: the recovered run closes the call as interrupted, the model asks again, and the run carries on to the answer. The agent must not re-invoke on its own — one instruction, one invocation, before the crash and after it alike. |
| [069-tool-timeout](./koans/069-tool-timeout.yaml) | The tool declares how long an invocation of it is waited for (`timeout_ms`), and the tool server accepts the call and never answers. The agent must give the invocation up at the declared timeout — not sooner: a declared wait is a promise to wait — with the timeout reaching the model as a tool failure, and the run carrying on to a graceful answer instead of dying. The agent must not re-invoke on its own; there is no follow-up call here, so exactly one invocation is made. |
| [070-retry-abort](./koans/070-retry-abort.yaml) | The caller's abort arrives twice — the same delivery, retried, once the run has already settled from the first. The second must be accepted too, and it must not rewrite the committed result: repeated aborts are idempotent (SPEC.md §3). |
| [071-retry-compact](./koans/071-retry-compact.yaml) | The caller's ask for a fold arrives twice — the same ask, re-sent while the fold it brought about is still summarizing. The repeat must not start a second fold: it joins the one already running, and both answers wait for that one fold to settle (SPEC.md §3). |
| [072-result-size-fidelity](./koans/072-result-size-fidelity.yaml) | A tool's result comes back large — tens of kilobytes, well past anything else in the suite. The agent must forward it to the model whole: nothing here says a size earns different treatment, and no declared tool's result is truncated, summarized, or otherwise altered on its way to the model (SPEC.md §4). |
| [073-undeclared-delegation](./koans/073-undeclared-delegation.yaml) | The model delegates to a subagent name the run never declared — a hallucination, not a typo the mock plays along with. The agent must open no child conversation: the refusal is the delegation's outcome, it reaches the parent's model the way an unknown tool call's does (004), and the model corrects itself with a delegation to the one name the run did declare. An implementation that wants open-ended, on-demand delegation offers it under a declared name of its own — a general-purpose delegate a caller names in `given.subagents` like any other — never by serving a name that does not exist, which is a hallucination the model deserves to hear about. |
| [074-follow-up-after-crash](./koans/074-follow-up-after-crash.yaml) | The death falls between submissions this time: after one turn settled, before the next was sent — the cheapest place a crash can land, since nothing is in flight when it does. The restarted process must resolve the same run and accept the next prompt like any other run does — a recovered run is never a wedged one — and that turn's model request must still carry the earlier turn's exchange: the follow-up contract (022), stretched across a death. |
| [075-crash-after-acceptance](./koans/075-crash-after-acceptance.yaml) | The death lands at the earliest point there is: the run was accepted, and nothing else ever happened — no model request, no work, only the acceptance itself on record. That record is enough. The restarted process must still resolve the same run and drive it to the answer it was always going to give; a doomed process's own first request, if it got one off, died with it — the recovered process asks again, which is recovery, not a retry (SPEC.md §3). |
| [076-crash-mid-delegation](./koans/076-crash-mid-delegation.yaml) | The agent's process is killed while a delegation is mid-task — the child's tool result already recorded, the child's next model request not yet answered — and started again. The sharp contrast with crash-in-flight-invocation: an in-flight tool invocation crossed into the world, so its outcome is unknown, and it is never re-invoked; a delegation never left the process, so nothing about it is unknown. The child's conversation is part of the run's record — what it had recorded survives the death the way the run's own record does, the child resumes to completion, and the delegation closes with the answer the child was always going to give, never with an unknown outcome. |
| [077-crash-during-recovery](./koans/077-crash-during-recovery.yaml) | The death lands twice: first while a tool invocation is in flight — 068's position, leaving an unclosed call the recovery must repair — and again while the recovered process is making that very repair, its own first model request in flight. What the first recovery wrote is recorded work like any other: the closure it gave the interrupted invocation is final, so the third process must not invoke that call again behind it — the tool is invoked exactly once across all three lives, and the model hears the unknown outcome exactly once. A recovery reads what it owes off the record rather than counting it, so no crash shape leaves the run half-repaired or repaired twice (SPEC.md §3). |
| [078-abort-survives-crash](./koans/078-abort-survives-crash.yaml) | An accepted abort is durable intent, not a message in flight. 019 says a late abort never rewrites a committed result; this says the mirror — a death never rewrites an accepted abort. The caller aborts a run still working, the process dies before it settled, and the restarted process must still settle it aborted, asking the world for nothing further. |
| [079-result-field-fidelity](./koans/079-result-field-fidelity.yaml) | A tool answers with several fields at once. Every one of them must reach the model, not just the one the agent judged interesting: a result is forwarded as it came back, and keeping one field out of a body alters it as surely as truncating it does (SPEC.md §4). |

<!-- koan-index:end -->

## 6. Versioning

The suite is versioned as a whole (semver):

- **major** — incompatible contract changes, or a change to what an
  existing koan means
- **minor** — new koans; existing koans unchanged
- **patch** — fixes that change no pass/fail outcome

Published koans are immutable: to change a koan's contract line, add one
that supersedes it and deprecate the old one, removed at the next major.
Pin a suite version, upgrade deliberately, and record known failures in a
skiplist with reasons rather than mixing koan versions. A conformance
claim that skips koans MUST name them and their reasons — the skiplist
is part of the claim, not a footnote to it.
