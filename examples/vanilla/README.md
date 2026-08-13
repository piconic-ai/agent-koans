# vanilla

An AI agent written in TypeScript, with no agent framework under it.

It asks a model what to do, and does it: executes the tools the model
calls, validates their arguments before it does, reports a failure back
instead of retrying on its own, delegates to subagents, reads files from a
workspace, carries a conversation across turns, folds that conversation
into a summary when it grows too large for the window, stops when a
request budget runs out, and settles when its caller aborts it.

There are two ways in, over the same agent: a terminal command, and an
HTTP server.

It is split the way an agent built on a framework is split. Everything
under `agent/` is machinery any agent needs — the loop, delegation, the
budget, the window, the run lifecycle — and it knows nothing about this
one. `assistant.ts` is the whole of what makes this agent this agent:
what it is told it is, and the tools it carries.

It is also the reference implementation of the
[agent-koans conformance contract](../../SPEC.md), and passes every koan in
the suite. The suite is how the behavior above is checked. It is not what
the agent is for: give it a real key and a real model and it answers from
a terminal, with no part of agent-koans involved.

Every file opens with a header saying what belongs in it and what does
not, so the file you want is the one whose header claims your change. Read
it beside [examples/flue](../flue), which meets the same contract on a
real framework: the line this example draws between `agent/` and
`assistant.ts` falls there between `@flue/runtime` and
`agents/assistant.ts`.

Web-standard APIs throughout (`fetch`, `crypto.randomUUID`), so it runs on
Node, Deno, and Bun. The one exception is `read-file.ts`: a workspace is a
filesystem, and the Web platform has no filesystem API.

## Usage

Which model to talk to comes from the environment, for both ways in.

| Variable | Meaning | Default |
| --- | --- | --- |
| `OPENAI_API_KEY` | Credential sent to the model endpoint | empty |
| `OPENAI_BASE_URL` | Model endpoint, OpenAI-compatible (includes `/v1`) | `https://api.openai.com/v1` |
| `OPENAI_MODEL` | Model to request | `gpt-4o-mini` |
| `PORT` | Port the HTTP server listens on | `3000` |
| `KOAN_WORKSPACE` | Directory `read_file` resolves against | the working directory |
| `KOAN_TOOLS_URL` | Service that runs a run's declared tools | empty |

The last two carry the conformance runner's names because that is what it
sets ([SPEC.md §2](../../SPEC.md)). Both are ordinary settings: a working
directory, and the service this agent invokes its tools on. The terminal
command takes them as options instead.

### From the terminal

```console
$ pnpm install
$ cd examples/vanilla
$ export OPENAI_API_KEY=sk-...
$ pnpm cli "What is the capital of Japan?"
Tokyo
```

With no prompt at all, the assistant reads them one per line and keeps
the conversation going:

```console
$ pnpm cli
> What is the capital of Japan?
Tokyo
> And its population, roughly?
The Greater Tokyo Area is usually estimated at over 37 million people.
```

What the assistant is told, and the tools it has, are its own
(`assistant.ts`), not something a caller passes. `--workspace` chooses
what `read_file` resolves against, and `--setup` takes a JSON file with
the run's `tools`, `subagents`, `limits` and `context`:

```json
{
  "tools": [
    {
      "name": "get_weather",
      "description": "Look up current weather for a city",
      "input_schema": {
        "type": "object",
        "properties": { "city": { "type": "string" } },
        "required": ["city"]
      }
    }
  ]
}
```

```console
$ pnpm cli --setup ./run.json --tools-url http://localhost:8080 \
      "What is the weather in Tokyo?"
```

A declared tool is invoked at `POST <tools-url>/invoke/<name>`, the model's
arguments as the body. `read_file` is the agent's own: it needs nothing
configured, and never leaves the process. `pnpm cli --help` lists every
option.

### As an HTTP server

```console
$ OPENAI_API_KEY=sk-... pnpm start
vanilla agent listening on :3000
```

A run executes in the background, so submitting a task returns an id to
poll:

```console
$ curl -s localhost:3000/runs -H 'content-type: application/json' \
       -d '{"prompt": "Read note.txt and tell me what it says."}'
{"run_id":"r_e3cb524b-3d57-4fb4-b110-c9ac7ff3248e"}

$ curl -s localhost:3000/runs/r_e3cb524b-3d57-4fb4-b110-c9ac7ff3248e
{"run_id":"r_e3cb524b-...","status":"completed","events":[],"output":"The note says it is 31 degrees."}
```

Continue the same conversation, or stop it:

```console
$ curl -s -X POST localhost:3000/runs/r_e3cb524b-.../prompts \
       -H 'content-type: application/json' -d '{"prompt": "And in Fahrenheit?"}'
$ curl -s -X POST localhost:3000/runs/r_e3cb524b-.../abort
```

Tools and subagents are declared per run, in the same shapes `--setup`
takes, and `KOAN_TOOLS_URL` says where a declared tool is invoked. Every
endpoint, with its full request and response schema, is in
[openapi.yaml](../../openapi.yaml) — which is why `--system` has no
counterpart here: that file defines this interface, and standing
instructions are not part of it.

### Against the suite

From the repository root:

```console
$ pnpm koan --agent "pnpm --silent start" --cwd examples/vanilla
ok    000-plain-completion
ok    001-happy-path
ok    002-arg-validation
...
```

`pnpm test` runs the same koans against every example at once.

## Files

This agent, and the two doors into it:

| File | What belongs in it |
| ---- | ------------------ |
| `assistant.ts` | What this agent is told it is, and the tools it carries |
| `read-file.ts` | One of those tools: reading a file from the workspace |
| `cli.ts` | Terminal adapter. Read arguments, submit a run, print the answer |
| `server.ts` | HTTP adapter. Parse a request, hand it over, answer |
| `config.ts` | Reading the environment, in one place |

What any agent would need, knowing nothing about this one:

| File | What belongs in it |
| ---- | ------------------ |
| `agent/index.ts` | The surface an agent is built on |
| `agent/lifecycle.ts` | The state a caller polls, the queue of turns, and the transitions between them |
| `agent/run.ts` | What a run is made of, assembled from a definition and a submission |
| `agent/conversation.ts` | The loop: ask the model, run what it asked for, ask again |
| `agent/model.ts` | The one place the agent talks to the model endpoint |
| `agent/tools.ts` | The shape every tool has, and the declared kind that reaches the tool service |
| `agent/subagents.ts` | Delegation, offered to the model as a tool |
| `agent/budget.ts` | How many model requests a run may spend |
| `agent/window.ts` | The context window a run declared, and how full a conversation is |
| `agent/compaction.ts` | Folding a conversation down to a summary |

The two tools fall on opposite sides of that line, which is what the line
means: reading a file is something anyone can write against the `Tool`
interface, while delegation is the loop re-entering itself, and only what
owns the loop can offer that.

`conversation.ts` holds the loop, and stays short because every step it
orders lives elsewhere. `run.ts` assembles what that loop is given — the
tools, the budget, the window, the model — which is why delegation is one
line there: a conversation of its own, and the same run.
