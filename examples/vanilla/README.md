# vanilla

An AI agent written in TypeScript, with no agent framework under it.

It asks a model what to do, and does it: executes the tools the model
calls, validates their arguments before it does, reports a failure back
instead of retrying on its own, delegates to subagents, reads files from a
workspace, carries a conversation across turns, folds that conversation
into a summary when it grows too large for the window, stops when a
request budget runs out, and settles when its caller aborts it.

It is also the reference implementation of the
[agent-koans conformance contract](../../SPEC.md), and passes every koan in
the suite. The suite is how the behavior above is checked. It is not what
the agent is for: point `OPENAI_BASE_URL` at a model endpoint and this
runs on its own, with no part of agent-koans involved.

Every file opens with a header saying what belongs in it and what does
not, so the file you want is the one whose header claims your change. Read
it beside [examples/flue](../flue), which meets the same contract on a
framework. Most files carry the same name in both, and the ones only this
example has are what the framework provides over there.

Web-standard APIs throughout (`fetch`, `crypto.randomUUID`), so it runs on
Node, Deno, and Bun. The one exception is `read-file.ts`: a workspace is a
filesystem, and the Web platform has no filesystem API.

## Usage

The agent is an HTTP server, configured entirely from the environment.

| Variable | Meaning | Default |
| --- | --- | --- |
| `OPENAI_API_KEY` | Credential sent to the model endpoint | empty |
| `OPENAI_BASE_URL` | Model endpoint, OpenAI-compatible (includes `/v1`) | `https://api.openai.com/v1` |
| `OPENAI_MODEL` | Model to request | `gpt-4o-mini` |
| `PORT` | Port to listen on | `3000` |
| `KOAN_WORKSPACE` | Directory `read_file` resolves against | the working directory |
| `KOAN_TOOLS_URL` | Service that runs a run's declared tools | empty |

The last two carry the conformance runner's names because that is what it
sets ([SPEC.md §2](../../SPEC.md)). Both are ordinary settings: a working
directory, and the service this agent invokes its tools on.

### As an agent

```console
$ pnpm install
$ cd examples/vanilla
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

`read_file` is the agent's own and needs nothing configured. Tools of your
own are declared per run, and invoked at
`POST $KOAN_TOOLS_URL/invoke/{name}` with the model's arguments as the
body:

```console
$ curl -s localhost:3000/runs -H 'content-type: application/json' -d '{
    "prompt": "What is the weather in Tokyo?",
    "tools": [{
      "name": "get_weather",
      "description": "Look up current weather for a city",
      "input_schema": {
        "type": "object",
        "properties": { "city": { "type": "string" } },
        "required": ["city"]
      }
    }]
  }'
```

Subagents are declared the same way, under `subagents`. Every endpoint,
with its full request and response schema, is in
[openapi.yaml](../../openapi.yaml).

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

| File | What belongs in it |
| ---- | ------------------ |
| `server.ts` | The HTTP endpoints. Parse a request, hand it over, answer |
| `config.ts` | Reading the environment, in one place |
| `agent.ts` | The state a caller polls, the queue of turns, and the transitions between them |
| `run.ts` | What a run is made of, assembled from what it was submitted with |
| `conversation.ts` | The loop: ask the model, run what it asked for, ask again |
| `model.ts` | The one place the agent talks to the model endpoint |
| `tools.ts` | The shape every tool has, and the declared kind that reaches the tool service |
| `read-file.ts` | The agent's own file reading, offered to the model as a tool |
| `subagents.ts` | Delegation, offered to the model as a tool |
| `budget.ts` | How many model requests a run may spend |
| `window.ts` | The context window a run declared, and how full a conversation is |
| `compaction.ts` | Folding a conversation down to a summary |

Two of these carry most of what makes an agent an agent. `conversation.ts`
holds the loop, and it stays short because every step it orders lives
elsewhere. `run.ts` assembles what that loop is given — the tools, the
budget, the window, the model — which is why delegation is one line there:
a conversation of its own, and the same run.
