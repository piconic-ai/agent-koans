# agent-koans

A framework-agnostic conformance suite for AI agent implementations.

Frameworks churn; contracts survive. agent-koans defines what a *correctly
built* agent loop looks like — argument validation, failure recovery,
idempotent execution, termination — as a set of deterministic, black-box
HTTP tests called **koans**. Build your agent with any framework (or none):
if it satisfies the contract, it passes.

Unlike evals, koans do not measure model capability. The model is fully
mocked, so every test is deterministic, fast, and free — and a failure
always means a missing safeguard in the *implementation*, never a bad roll
of the model dice.

- **[SPEC.md](./SPEC.md)** — the conformance contract (normative)
- **[SPEC.ja.md](./SPEC.ja.md)** — Japanese translation (informative)
- **koans/** — the test suite as declarative YAML, organized in chapters
- **runner/** — reference harness: mock LLM server (OpenAI-compatible),
  mock tool server, and a Vitest-based runner
- **examples/vanilla-ts/** — a no-framework reference implementation
- **examples/flue/** — the same contract implemented with the
  [Flue](https://flueframework.com/) agent framework

## Quick start

```sh
pnpm install
pnpm test          # runs the suite against every implementation in examples/
```

Run the suite against your own implementation:

```sh
AGENT_CMD="<command that starts your agent>" AGENT_CWD="<dir>" pnpm test
```

Your agent reads `PORT`, `OPENAI_BASE_URL`, `OPENAI_API_KEY`, and
`KOAN_TOOLS_URL` from the environment, serves `GET /health`, `POST /runs`,
and `GET /runs/{id}`, and talks to the mock servers. See
[SPEC.md](./SPEC.md) for the full contract.

## Chapters

| Chapter            | Verifies                                        |
| ------------------ | ----------------------------------------------- |
| `lifecycle`        | The minimal run lifecycle contract              |
| `tool-reliability` | Tool-calling reliability: validation, recovery, idempotency |

## Status

Early draft (M1): 4 koans, the reference runner, and one example
implementation. The suite and SPEC are expected to change without notice
until 1.0.
