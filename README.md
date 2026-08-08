# agent-koans

**agent-koans** — a *koan* (公案) is a riddle used in Zen practice to
test a student's understanding — is a framework-agnostic conformance
suite for AI agent implementations.

An agent's failure is the sum of model failure and implementation failure.
Evals measure the sum; agent-koans isolates the latter. Each **koan** is a
deterministic black-box test: the harness drives your agent over HTTP,
plays the model's part with a scripted mock, and verifies that the
implementation honors the contract. No real LLM calls — every failure
means a missing safeguard in the implementation, never a bad roll of the
model dice. Any framework, any runtime: satisfy the contract and you pass.

The contract lives in [SPEC.md](./SPEC.md).

## Usage

Your agent is an HTTP server that:

1. reads `PORT`, `OPENAI_BASE_URL`, `OPENAI_API_KEY`, and `KOAN_TOOLS_URL`
   from the environment
2. serves `GET /health`, `POST /runs`, and `GET /runs/{id}`

Run the suite against it:

```sh
pnpm install
AGENT_CMD="<command that starts your agent>" AGENT_CWD="<its directory>" pnpm test
```

Plain `pnpm test` runs the suite against everything in `examples/` —
reference implementations of the contract, with and without an agent
framework. Start from one of them.

## Repository

| Path        | Contents                                                    |
| ----------- | ----------------------------------------------------------- |
| `SPEC.md`   | The conformance contract — the real deliverable             |
| `openapi.yaml` | Wire format of the agent HTTP interface (OpenAPI 3.1)    |
| `koans/`    | The tests, as declarative YAML                              |
| `runner/`   | Mock LLM server (OpenAI-compatible), mock tool server, harness |
| `examples/` | Implementations that pass                                   |
