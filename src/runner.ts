// Runs one koan against one agent implementation: spawns the mocks,
// starts the agent, submits the run, polls to a terminal state, then
// judges the result against `then`. Process orchestration and pass/fail
// aggregation belong here; what to verify is decided by the compiled
// koan and the mocks.
import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { DelegationVocabulary } from './config.js';
import { actionsDuringOf, type Judgment, type Koan, type Matcher, type Trace } from './koan.js';
import { startMockLlm } from './mock-llm.js';
import { startMockTools } from './mock-tools.js';
import { createHold, deepEqual, type PendingInvocation } from './pending.js';

/** How to launch the agent under test. */
export interface AgentConfig {
  /** Shell command that starts the agent (run via `sh -c`). */
  command: string;
  /** Working directory for the command. */
  cwd?: string;
  /** Milliseconds to wait for `GET /health`. Default 10000. */
  startupTimeoutMs?: number;
  /** Milliseconds to wait for a terminal run state. Default 15000. */
  runTimeoutMs?: number;
  /**
   * The implementation's delegation wire vocabulary,
   * usually loaded from its `agent-koans.yaml`. Absent means the neutral
   * default: a `subagent` tool with `name`/`prompt` arguments.
   */
  delegation?: DelegationVocabulary;
}

const TERMINAL_STATES = new Set(['completed', 'failed', 'aborted']);

// A declared `max_duration_ms` (SPEC.md §3) is checked from both ends: an
// agent must not still be running well past it (the grace absorbs the
// mocks' and the poll loop's own overhead, which is not the agent's to
// answer for), and it must not have settled aborted well before it either
// (a budget is a ceiling, not a quota to spend — 045's contract line for
// max_model_requests, restated here for wall time). Both are slack, not
// precision: a budget this suite can pin to the millisecond would be
// pinning the mocks' own timing, not the agent's.
const TIME_LIMIT_GRACE_MS = 2000;
const TIME_LIMIT_EARLY_EPSILON_MS = 250;

// Recovery after a scripted crash runs on the implementation's own
// reconciliation cadence — lease expiries, scan intervals — which the
// suite must not pin (the same reasoning as the time-limit grace: a
// bound tight enough to measure the agent would be measuring its
// scheduler instead). A crashed trace therefore polls against this
// recovery window rather than the generic run timeout.
const CRASH_RECOVERY_TIMEOUT_MS = 60_000;

// Delivery slack for a repeated fold ask (`retry: compact`), not a timing
// assertion: the mock's held response travels back to the agent over an
// already-open connection once released, while the repeated ask is a fresh
// request this process has to send and the agent has to receive — an
// inherently slower path with no observable receipt this suite can await
// instead (the ask is answered only once the fold ends, so awaiting it here
// would deadlock against the hold). This just keeps that delivery from
// landing after the held fold has already been let go; what still decides
// conformance is one fold, pinned by the script's own request count and
// judgeReportedFolds below — never this wait.
const RETRY_COMPACT_DELIVERY_SLACK_MS = 100;

/** The run state as returned by `GET /runs/{run_id}` — only the fields this module reads. */
interface RunState {
  status?: string;
  output?: string;
  error?: string;
  events?: Array<{ type?: string; phase?: string; error?: string }>;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// Waits for one terminal state, from its own fresh deadline: a `turns:`
// koan calls this once per turn, and a later turn must not
// be charged for time an earlier one already spent waiting.
//
// `settled` is what a mid-run prompt adds: a queueing agent settles the
// submission it interrupted first, so its first terminal state is not the
// run's last word.
//
// `onOverrun` lets a caller polling against its own declared budget
// (`pollWithinBudget` below) report the overrun naming that budget,
// instead of this function's generic wording — the two callers disagree
// on what the deadline even means, so the message is theirs to choose.
async function pollToTerminal(
  base: string,
  runId: string,
  runTimeoutMs: number,
  settled?: () => boolean,
  onOverrun?: (run: RunState) => string,
): Promise<RunState> {
  const deadline = Date.now() + runTimeoutMs;
  for (;;) {
    const res = await fetch(`${base}/runs/${runId}`);
    if (!res.ok) throw new Error(`GET /runs/${runId} returned ${res.status}`);
    const run = (await res.json()) as RunState;
    const terminal = TERMINAL_STATES.has(String(run.status));
    if (terminal && (settled === undefined || settled())) return run;
    if (Date.now() > deadline) {
      // It kept the terminal-state promise; what it broke is the script,
      // and the underrun check names that exactly.
      if (terminal) return run;
      throw new Error(
        onOverrun ? onOverrun(run) : `terminal-state guarantee violated: run still "${run.status}" after ${runTimeoutMs}ms`,
      );
    }
    await sleep(100);
  }
}

// Wraps pollToTerminal with a submission's own declared time budget
// (SPEC.md §3), when `maxDurationMs` is set: the poll deadline becomes
// the budget plus grace instead of the generic run timeout, and a still-
// running overrun names the declared field. `elapsed` is read off
// `acceptedAt` regardless — the caller compares it against the same
// budget once the submission settles, to catch the opposite failure: an
// agent that gives up before the budget expires.
async function pollWithinBudget(
  base: string,
  runId: string,
  runTimeoutMs: number,
  acceptedAt: number,
  maxDurationMs: number | undefined,
  settled?: () => boolean,
): Promise<{ run: RunState; elapsed: number }> {
  const run =
    maxDurationMs === undefined
      ? await pollToTerminal(base, runId, runTimeoutMs, settled)
      : await pollToTerminal(
          base,
          runId,
          maxDurationMs + TIME_LIMIT_GRACE_MS,
          settled,
          (r) =>
            `run still "${r.status}" ${Date.now() - acceptedAt}ms after acceptance, past ` +
            `given.limits.max_duration_ms (${maxDurationMs}ms) plus grace`,
        );
  return { run, elapsed: Date.now() - acceptedAt };
}

// The other half of the time-budget contract (SPEC.md §3): a budget is a
// ceiling, not a quota to spend, so settling aborted well inside it is as
// much a violation as running past it — even though the koan's own
// `then` may legitimately expect `aborted` (065 does), a settle this
// early means nothing but the budget itself could have ended the run.
function earlyAbortFailure(elapsed: number, maxDurationMs: number): string {
  return (
    `the run settled aborted ${elapsed}ms after acceptance, before its declared ` +
    `given.limits.max_duration_ms (${maxDurationMs}ms) — a time budget is a ceiling, not permission to stop early`
  );
}

// Awaits `p`, or fails at `deadline`: an agent that never reaches the
// held invocation must fail naming that, rather than hang.
async function within<T>(p: Promise<T>, deadline: number, onTimeout: () => string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      p,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(onTimeout())), Math.max(0, deadline - Date.now()));
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Find a free loopback port to start an agent on. */
export async function getFreePort(): Promise<number> {
  const { createServer } = await import('node:net');
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address() as { port: number };
      srv.close(() => resolve(port));
    });
    srv.on('error', reject);
  });
}

async function waitForHealth(base: string, timeoutMs: number, child: ChildProcess): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`agent process exited with code ${child.exitCode} before becoming healthy`);
    }
    try {
      const res = await fetch(`${base}/health`);
      if (res.ok) return;
    } catch {
      // not up yet
    }
    await sleep(100);
  }
  throw new Error(`agent did not become healthy within ${timeoutMs}ms`);
}

function match(label: string, actual: unknown, matcher: Matcher): string | null {
  if (matcher !== null && typeof matcher === 'object') {
    if ('equals' in matcher) {
      const ok = JSON.stringify(actual) === JSON.stringify(matcher.equals);
      return ok ? null : `${label}: expected ${JSON.stringify(matcher.equals)}, got ${JSON.stringify(actual)}`;
    }
    if ('contains' in matcher && matcher.contains !== undefined) {
      const ok = String(actual ?? '').includes(matcher.contains);
      return ok ? null : `${label}: expected to contain ${JSON.stringify(matcher.contains)}, got ${JSON.stringify(actual)}`;
    }
    if ('matches' in matcher && matcher.matches !== undefined) {
      const ok = new RegExp(matcher.matches).test(String(actual ?? ''));
      return ok ? null : `${label}: expected to match /${matcher.matches}/, got ${JSON.stringify(actual)}`;
    }
    return `${label}: unknown matcher ${JSON.stringify(matcher)}`;
  }
  return actual === matcher ? null : `${label}: expected ${JSON.stringify(matcher)}, got ${JSON.stringify(actual)}`;
}

// Judges one run's outcome against one `then` block — the top-level one
// for a `when`/`one_of` koan, or one turn's own for a `turns:` koan:
// both are the same flat `{ status, output }` shape.
function judge(then: Judgment, run: RunState): string[] {
  const failures: string[] = [];
  if (then.status !== undefined && run.status !== then.status) {
    failures.push(`run.status: expected "${then.status}", got "${run.status}"${run.error ? ` (error: ${run.error})` : ''}`);
  }
  if (then.output !== undefined) {
    const failure = match('run.output', run.output, then.output);
    if (failure) failures.push(failure);
  }
  return failures;
}

// Both ends of a declared tool timeout (SPEC.md §3), measured between an
// unanswered invocation's arrival at the tool mock and the next model
// request — the one that carries the give-up. Given up before the
// declared timeout fails (a declared wait is a promise to wait, not
// permission to give up sooner — 045's and 065's contract line, restated
// for a dependency's clock); still being waited on well past it fails
// too. Epsilon and grace are 065's: slack for the mocks' own timing, not
// precision.
function judgeToolTimeouts(
  koan: Koan,
  trace: Trace,
  llmState: { requestAt: number[]; requestConv: Array<string | undefined> },
  calls: Array<{ name: string; args: unknown; at: number }>,
): string[] {
  const failures: string[] = [];
  // Consumed as matched, so a tool invoked more than once maps each
  // scripted invocation to exactly one observed call, in arrival order.
  const usedCalls = new Set<number>();
  for (const conv of trace.conversations) {
    for (const turn of conv.turns) {
      for (const member of turn.call_tools ?? []) {
        if (member.tool_responds === undefined || !('never' in member.tool_responds)) continue;
        const timeoutMs = koan.given.tools[member.name]?.timeout_ms;
        if (timeoutMs === undefined) continue;
        // Never invoked, or never given up: both already fail elsewhere
        // (the unconsumed timeline, the run that cannot settle) — this
        // check owns only the window between the two.
        const expectedArgs = member.invokeArgs ?? member.args ?? {};
        const callIndex = calls.findIndex(
          (c, i) => !usedCalls.has(i) && c.name === member.name && deepEqual(c.args, expectedArgs),
        );
        if (callIndex === -1) continue;
        usedCalls.add(callIndex);
        const invokedAt = calls[callIndex].at;
        // The give-up is carried by this conversation's own next request:
        // another conversation's, interleaved while this call hangs, says
        // nothing about this call.
        const closedAt = llmState.requestAt.find(
          (at, i) => at > invokedAt && llmState.requestConv[i] === conv.name,
        );
        if (closedAt === undefined) continue;
        const waited = closedAt - invokedAt;
        if (waited < timeoutMs - TIME_LIMIT_EARLY_EPSILON_MS) {
          failures.push(
            `the "${member.name}" invocation was given up ${waited}ms after it arrived, before its declared ` +
              `timeout_ms (${timeoutMs}ms) — a declared wait is a promise to wait, not permission to give up sooner`,
          );
        } else if (waited > timeoutMs + TIME_LIMIT_GRACE_MS) {
          failures.push(
            `the "${member.name}" invocation was still being waited on ${waited}ms after it arrived, past its ` +
              `declared timeout_ms (${timeoutMs}ms) plus grace`,
          );
        }
      }
    }
  }
  return failures;
}

// Endings only: a run that has answered the ask has folded, and one that
// has reported a fold beginning has not said how it went.
function foldsEnded(run: RunState): number {
  return (run.events ?? []).filter((e) => e.type === 'compaction' && e.phase !== 'started').length;
}

// What the caller was told about the folds the trace scripts (SPEC.md
// §3). Read from the settled run rather than watched as it happens: a
// client polls, so the record has to survive the activity it describes.
// Only how each fold ended is read: a failure's own words are the
// implementation's, and the same failure in two vocabularies is the same
// failure.
function judgeReportedFolds(trace: Trace, run: RunState): string[] {
  // One fold, one report — however many requests it cost (koan-spec.ts's
  // header): only a group's leader (`foldMember` `0`, or absent for a
  // failed fold, which is always one request) counts, so a fold served by
  // several requests is still counted once here.
  const folds = trace.conversations.flatMap((c) => c.turns.filter((t) => t.compaction && (t.foldMember ?? 0) === 0));
  const reported = (run.events ?? []).filter((e) => e.type === 'compaction');
  // A fold's beginning is the request itself; the koan writes only how it
  // ended, so that is the only phase read off the trace.
  const expected = folds.flatMap((t) => ['started', t.compaction as string]);
  const actual = reported.map((e) => String(e.phase));
  if (actual.length !== expected.length || actual.some((phase, i) => phase !== expected[i])) {
    const detail = reported.map((e) => `${e.phase}${e.error ? ` (${e.error})` : ''}`).join(', ') || 'nothing';
    return [
      `the run reported ${detail} to its caller, but the trace folds the conversation down ${folds.length} time(s): ` +
        `GET /runs/{run_id} must carry a "compaction" event when a fold starts and one when it ends`,
    ];
  }
  return [];
}

/**
 * Run a koan against an agent: once per trace variant, until one passes.
 * Resolves on conformance; throws with every variant's failures otherwise.
 */
export async function runKoan(koan: Koan, agent: AgentConfig): Promise<void> {
  const variants = Object.entries(koan.traces);
  const allFailures: string[] = [];
  for (const [variant, trace] of variants) {
    const failures = await runTrace(koan, trace, agent);
    if (failures.length === 0) return;
    allFailures.push(...(variant ? failures.map((f) => `[${variant}] ${f}`) : failures));
  }
  throw new Error(`koan "${koan.name}" failed:\n  - ${allFailures.join('\n  - ')}`);
}

async function runTrace(koan: Koan, trace: Trace, agent: AgentConfig): Promise<string[]> {
  const pending: PendingInvocation[] = [];
  // Created here rather than inside a mock: both ends of each window are
  // held by this driver and the tool mock, one hold per held caller
  // action (a mid-run prompt, or a re-send of the creation).
  const actions = actionsDuringOf(trace);
  const holds = actions.map(() => createHold());
  const llm = await startMockLlm(koan, trace, pending, agent.delegation, holds);
  const tools = await startMockTools(pending);
  const port = await getFreePort();
  const base = `http://127.0.0.1:${port}`;
  const totalTurns = trace.conversations.reduce((n, c) => n + c.turns.length, 0);
  const subagentNames = trace.conversations.filter((c) => c.name !== '').map((c) => c.name);

  // Always created, even without given.files: KOAN_WORKSPACE is part of
  // the environment contract (SPEC.md §2), and an agent must be able to
  // rely on it existing. `mkdtempSync` itself is outside the try below —
  // if it fails, nothing was created, so there is nothing for the finally
  // to clean up — but everything after it (materializing given.files,
  // spawning the agent) moves inside: a failing write (ENOSPC, EPERM)
  // must still leave the finally block to remove `workspace`.
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-koans-'));
  // Beside the workspace, not inside it: KOAN_WORKSPACE is context the
  // caller hands the run, KOAN_STATE_DIR is where a durable
  // implementation keeps what must outlive its process (SPEC.md §2). The
  // runner passes the same path to every spawn of this koan — a scripted
  // crash's restart included — and removes it with the koan.
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-koans-state-'));
  let child: ChildProcess | undefined;

  const startAgent = () => {
    child = spawn('sh', ['-c', agent.command], {
      cwd: agent.cwd,
      env: {
        ...process.env,
        PORT: String(port),
        OPENAI_BASE_URL: `${llm.url}/v1`,
        OPENAI_API_KEY: 'koan-dummy-key',
        KOAN_TOOLS_URL: tools.url,
        KOAN_WORKSPACE: workspace,
        KOAN_STATE_DIR: stateDir,
      },
      stdio: ['ignore', 'inherit', 'inherit'],
      // Own process group, killed as a group below: killing only the
      // direct child leaves the agent's own children (pnpm → sh → node)
      // running and holding the inherited stdio open.
      detached: true,
    });
  };
  // `child` is undefined when materialization or spawn itself failed
  // before ever producing a process — nothing to kill or wait for then.
  const killTree = (signal: NodeJS.Signals) => {
    if (!child || child.pid === undefined) return;
    try {
      process.kill(-child.pid, signal);
    } catch {
      /* group already gone */
    }
  };
  const waitExit = () =>
    new Promise<void>((r) => {
      if (!child || child.exitCode !== null) return r();
      child.on('exit', () => r());
    });

  const failures: string[] = [];
  try {
    try {
      for (const [rel, content] of Object.entries(koan.given.files ?? {})) {
        const dest = path.join(workspace, rel);
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        fs.writeFileSync(dest, content);
      }

      startAgent();

      await waitForHealth(base, agent.startupTimeoutMs ?? 10_000, child as ChildProcess);

      // A `turns:` koan submits its first turn's prompt the
      // same way any koan submits its top-level `prompt`; later turns go
      // to POST /runs/{id}/prompts instead.
      const opening = koan.turns?.[0];
      const firstPrompt = opening?.kind === 'prompt' ? opening.prompt : (koan.prompt as string);

      // A trace whose caller retries its creation names the run itself
      // (SPEC.md §3): only a caller that knows the name it asked for can
      // show the resend landed on the same run. Minted fresh per
      // execution, never written in the koan — a fixed name would land a
      // re-run of the suite on the previous execution's settled run.
      const clientRunId = actions.some((a) => a.kind === 'retry') ? `koan-${randomUUID()}` : undefined;
      // Kept verbatim for the retry: what the caller re-sends is the
      // identical request, not a semantically-equal one.
      const submitBody = JSON.stringify({
        prompt: firstPrompt,
        ...(clientRunId !== undefined ? { run_id: clientRunId } : {}),
        tools: Object.entries(koan.given.tools).map(([name, def]) => ({ name, ...def })),
        ...(subagentNames.length > 0
          ? {
              subagents: subagentNames.map((name) => {
                const setup = koan.given.subagents?.[name];
                return setup === undefined ? { name } : { name, context: setup.context };
              }),
            }
          : {}),
        ...(koan.given.limits ? { limits: koan.given.limits } : {}),
        ...(koan.given.context ? { context: koan.given.context } : {}),
      });
      const submitRes = await fetch(`${base}/runs`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: submitBody,
      });
      if (submitRes.status !== 201 && submitRes.status !== 202) {
        throw new Error(`POST /runs returned ${submitRes.status}, expected 201 or 202`);
      }
      // The clock a declared max_duration_ms is measured against
      // (SPEC.md §3) starts here, at acceptance — not wherever below this
      // submission happens to finish polling.
      const openingAcceptedAt = Date.now();
      const maxDurationMs = koan.given.limits?.max_duration_ms;
      const { run_id: runId } = (await submitRes.json()) as { run_id?: string };
      if (typeof runId !== 'string' || runId.length === 0) {
        throw new Error('POST /runs response is missing "run_id"');
      }
      if (clientRunId !== undefined && runId !== clientRunId) {
        throw new Error(
          `POST /runs was asked to create run "${clientRunId}" but answered run_id "${runId}" — a caller-named run keeps its name (SPEC.md §3)`,
        );
      }

      // A `turns:` koan never scripts `abort` (koan.ts rejects it), so
      // abortKind is always undefined for one — this whole branch is
      // unreached and the run-timeout deadline below serves only the
      // live-abort wait.
      const abortKind = trace.conversations[0].turns.at(-1)?.abort;
      const deadline = Date.now() + (agent.runTimeoutMs ?? 15_000);

      // Fire the abort exactly when the trace says the caller does: as
      // soon as every step before it has been observed on the wire. A
      // request that then races ahead of the abort landing is parked by
      // the mock (mock-llm.ts), not rejected here — so whichever one
      // wins, the run has nothing left to do but settle aborted.
      const waitForPreAbortSteps = async () => {
        while (!(llm.state.requests.length >= totalTurns && pending.length === 0)) {
          if (Date.now() > deadline) {
            throw new Error(
              `abort trace's pre-abort steps were not fully observed within ${agent.runTimeoutMs ?? 15_000}ms: ` +
                `${llm.state.requests.length}/${totalTurns} model requests served, ${pending.length} tool call(s) still unresolved`,
            );
          }
          await sleep(100);
        }
      };
      const postAbort = async () => {
        const abortRes = await fetch(`${base}/runs/${runId}/abort`, { method: 'POST' });
        if (abortRes.status !== 202 && abortRes.status !== 200) {
          throw new Error(`POST /runs/${runId}/abort returned ${abortRes.status}, expected 202 or 200`);
        }
      };

      // A scripted crash: SIGKILL — no warning, no grace — then the same
      // command again, against the same PORT and the same KOAN_STATE_DIR.
      // The mock's gate opens (liftCrashGate) only once the restarted
      // process reports healthy, so the next exchange provably belongs to
      // the recovered run.
      const crashAndRecover = async () => {
        killTree('SIGKILL');
        await waitExit();
        startAgent();
        try {
          await waitForHealth(base, agent.startupTimeoutMs ?? 10_000, child as ChildProcess);
        } catch (err) {
          throw new Error(`the agent did not come back after the crash: ${err instanceof Error ? err.message : String(err)}`);
        }
        llm.liftCrashGate();
      };

      if (abortKind === 'live' && actions.length === 0) {
        await waitForPreAbortSteps();
        await postAbort();
      }

      for (const [k, action] of actions.entries()) {
        // A retried fold ask is the turns loop's to deliver — the ask
        // that engages its hold has not even been sent yet here.
        if (action.kind === 'compact') continue;
        const label =
          action.kind === 'prompt'
            ? `mid-run prompt #${actions.slice(0, k + 1).filter((a) => a.kind === 'prompt').length}`
            : action.kind === 'retry'
              ? 'the creation retry'
              : 'the crash';
        await within(
          holds[k].engaged,
          Date.now() + (agent.runTimeoutMs ?? 15_000),
          () =>
            `the tool invocation the trace holds open for ${label} was never made within ` +
            `${agent.runTimeoutMs ?? 15_000}ms`,
        );
        try {
          if (action.kind === 'prompt') {
            const promptRes = await fetch(`${base}/runs/${runId}/prompts`, {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ prompt: action.prompt }),
            });
            if (promptRes.status !== 202 && promptRes.status !== 200) {
              throw new Error(
                `POST /runs/${runId}/prompts returned ${promptRes.status} for a run still running, expected 202 or 200`,
              );
            }
          } else if (action.kind === 'crash') {
            // The invocation is in flight and unanswered: exactly the
            // moment SPEC.md §3's recovery contract is about.
            await crashAndRecover();
          } else {
            // The identical creation, again, while the run provably has
            // not settled (SPEC.md §3): the same acceptance must come
            // back, naming the same run — not a second run, not an error.
            const retryRes = await fetch(`${base}/runs`, {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: submitBody,
            });
            if (retryRes.status !== 201 && retryRes.status !== 202) {
              throw new Error(
                `the retried POST /runs returned ${retryRes.status} — an identical creation resent must land on ` +
                  `the same acceptance (201/202), not a different outcome`,
              );
            }
            const retried = (await retryRes.json()) as { run_id?: string };
            if (retried.run_id !== runId) {
              throw new Error(
                `the retried POST /runs answered run_id ${JSON.stringify(retried.run_id)} — the caller named ` +
                  `"${runId}", so the identical resend must land on that run, not create another`,
              );
            }
          }
          // A live abort scripted after a delivered prompt lands while the
          // delivery's invocation is still held, so the prompt is provably
          // accepted and provably unanswered when the abort arrives.
          if (abortKind === 'live' && k === actions.length - 1) {
            await waitForPreAbortSteps();
            await postAbort();
          }
        } finally {
          // Released even on failure: the tool mock is parked on this,
          // and its server cannot close until it returns.
          holds[k].release();
        }
      }

      // A bare `crash` step fires once every exchange before it has been
      // observed on the wire — the same seam the scripted abort uses. The
      // mock's gate holds the next exchange meanwhile, so nothing the
      // doomed process races out can settle the run before it dies.
      const crashBefore = trace.conversations[0].crashBefore;
      const crashed = crashBefore !== undefined || actions.some((a) => a.kind === 'crash');
      if (crashBefore !== undefined) {
        const crashDeadline = Date.now() + (agent.runTimeoutMs ?? 15_000);
        while ((llm.state.served[''] ?? 0) < crashBefore || pending.length !== 0) {
          if (Date.now() > crashDeadline) {
            throw new Error(
              `the trace's pre-crash steps were not fully observed within ${agent.runTimeoutMs ?? 15_000}ms: ` +
                `${llm.state.served[''] ?? 0}/${crashBefore} model requests served, ${pending.length} tool call(s) still unresolved`,
            );
          }
          await sleep(100);
        }
        await crashAndRecover();
      }

      const scriptConsumed = () =>
        trace.conversations.every((c) => (llm.state.served[c.name] ?? 0) >= c.turns.length) && pending.length === 0;

      let { run, elapsed } = await pollWithinBudget(
        base,
        runId,
        crashed ? CRASH_RECOVERY_TIMEOUT_MS : (agent.runTimeoutMs ?? 15_000),
        openingAcceptedAt,
        maxDurationMs,
        actions.some((a) => a.kind === 'prompt') ? scriptConsumed : undefined,
      );
      // Not checked for a scripted abort: the harness's own postAbort()
      // above settles the run aborted on the trace's own schedule, which
      // has nothing to do with the declared budget.
      if (maxDurationMs !== undefined && run.status === 'aborted' && abortKind === undefined && elapsed < maxDurationMs - TIME_LIMIT_EARLY_EPSILON_MS) {
        failures.push(earlyAbortFailure(elapsed, maxDurationMs));
      }

      // The caller's own abort, delivered again once the run has settled
      // from the first (SPEC.md §3: repeated aborts are idempotent) —
      // must still be accepted, and must not rewrite what it settled on.
      if (trace.conversations[0].turns.at(-1)?.abortRetried) {
        const before = { status: run.status, output: run.output, error: run.error };
        const retryRes = await fetch(`${base}/runs/${runId}/abort`, { method: 'POST' });
        if (retryRes.status !== 202 && retryRes.status !== 200) {
          throw new Error(
            `the retried POST /runs/${runId}/abort returned ${retryRes.status}, expected 202 or 200 — ` +
              `repeated aborts are idempotent (SPEC.md §3)`,
          );
        }
        const res = await fetch(`${base}/runs/${runId}`);
        if (!res.ok) throw new Error(`GET /runs/${runId} returned ${res.status}`);
        run = (await res.json()) as RunState;
        const after = { status: run.status, output: run.output, error: run.error };
        if (JSON.stringify(after) !== JSON.stringify(before)) {
          failures.push(
            `a repeated abort rewrote the committed result: was ${JSON.stringify(before)}, now ${JSON.stringify(after)} — ` +
              `repeated aborts are idempotent (SPEC.md §3)`,
          );
        }
      }

      // Every turn but the last is judged here, against its own `then`;
      // the last turn's judgment happens below, together
      // with the plain `when`/`one_of` koan's, once the run has fully
      // settled (including any late abort). A turn that did not land
      // `completed` leaves nothing meaningful to continue, so the runner
      // stops sending further prompts right there — `stoppedEarly` records
      // this, so the last turn's judgment below is skipped: that turn
      // never ran, and judging it would report a failure about the wrong
      // turn's expectations against the state the one that actually
      // stopped left behind.
      let stoppedEarly = false;
      // One hold per retried fold ask, in turn order. In a `turns:` koan
      // these are the only held actions parse.ts admits, so the filter
      // narrows nothing today — it keeps the pairing explicit.
      const foldHolds = actions.flatMap((a, k) => (a.kind === 'compact' ? [holds[k]] : []));
      let nextFoldHold = 0;
      if (koan.turns) {
        for (let t = 1; t < koan.turns.length; t++) {
          const previous = koan.turns[t - 1];
          if (previous.kind === 'prompt') {
            failures.push(...judge(previous.then, run));
            if (run.status !== 'completed') {
              stoppedEarly = true;
              failures.push(`turn ${t} of ${koan.turns.length} did not complete; the rest of the koan was not sent`);
              break;
            }
          }
          const entry = koan.turns[t];
          if (entry.kind === 'compact') {
            const before = foldsEnded(run);
            const askInit = {
              method: 'POST',
              ...(entry.instructions !== undefined
                ? {
                    headers: { 'content-type': 'application/json' },
                    body: JSON.stringify({ instructions: entry.instructions }),
                  }
                : {}),
            };
            if (!entry.retried) {
              const compactRes = await fetch(`${base}/runs/${runId}/compact`, askInit);
              if (compactRes.status !== 202 && compactRes.status !== 200) {
                throw new Error(`POST /runs/${runId}/compact returned ${compactRes.status}, expected 202 or 200`);
              }
              // Read here rather than at the end: the answer to the ask
              // says the fold has happened (SPEC.md §3), so a caller
              // holding it knows what came of pressing the button before
              // it types the next thing.
              const asked = await fetch(`${base}/runs/${runId}`);
              if (!asked.ok) throw new Error(`GET /runs/${runId} returned ${asked.status}`);
              run = (await asked.json()) as RunState;
              if (foldsEnded(run) === before) {
                failures.push(
                  `POST /runs/${runId}/compact answered before the fold ended: a run answers the ask once it has folded, ` +
                    `so a "compaction" event saying completed or failed is in GET /runs/{run_id} by then`,
                );
              }
              continue;
            }

            // The same ask, twice: fire the first, wait until its fold's
            // own summarizing request is provably in flight (held by the
            // mock), deliver the identical ask again, then let the fold
            // go. What convergence must show is one fold, which
            // judgeReportedFolds and the script's own request count already
            // pin — never the delivery slack below.
            const hold = foldHolds[nextFoldHold++];
            const askA = fetch(`${base}/runs/${runId}/compact`, askInit);
            // Observed below via Promise.all; caught here too so an
            // engagement timeout doesn't leave this rejection unhandled.
            askA.catch(() => {});
            let askB!: Promise<Response>;
            try {
              await within(
                hold.engaged,
                Date.now() + (agent.runTimeoutMs ?? 15_000),
                () =>
                  `the summarizing request the trace holds open for the repeated ask was never made within ` +
                  `${agent.runTimeoutMs ?? 15_000}ms`,
              );
              askB = fetch(`${base}/runs/${runId}/compact`, askInit);
              askB.catch(() => {});
              // Delivery slack, not a timing assertion (RETRY_COMPACT_DELIVERY_SLACK_MS):
              // once released, the held response reaches the agent over its
              // own already-open connection to the mock, while askB is a
              // fresh request this process still has to deliver — a slower
              // path with no receipt this suite can await instead (the ask
              // is answered only once the fold ends, so awaiting askB here
              // would deadlock against the hold). This only keeps askB's
              // delivery from landing after the released fold has already
              // finished; it decides nothing about conformance.
              await sleep(RETRY_COMPACT_DELIVERY_SLACK_MS);
            } finally {
              // Released even on failure: the mock is parked on this, and
              // its server cannot close until it returns.
              hold.release();
            }
            const judgeAsk = async (ask: Promise<Response>, label: string, joinNote: string): Promise<void> => {
              const res = await ask;
              if (res.status !== 202 && res.status !== 200) {
                throw new Error(`${label} POST /runs/${runId}/compact returned ${res.status}, expected 202 or 200${joinNote}`);
              }
              const asked = await fetch(`${base}/runs/${runId}`);
              if (!asked.ok) throw new Error(`GET /runs/${runId} returned ${asked.status}`);
              if (foldsEnded((await asked.json()) as RunState) === before) {
                failures.push(
                  `${label} POST /runs/${runId}/compact answered before the fold ended: a run answers the ask once it has ` +
                    `folded, so a "compaction" event saying completed or failed is in GET /runs/{run_id} by then`,
                );
              }
            };
            await Promise.all([
              judgeAsk(askA, 'the first', ''),
              judgeAsk(
                askB,
                'the repeated',
                ' — an identical ask re-sent mid-fold joins the running fold, it is not an error (SPEC.md §3)',
              ),
            ]);
            // Refreshed after both: judgeReportedFolds below judges this
            // same `run`, and either ask's own read above could be stale
            // by the time the other settles.
            const settled = await fetch(`${base}/runs/${runId}`);
            if (!settled.ok) throw new Error(`GET /runs/${runId} returned ${settled.status}`);
            run = (await settled.json()) as RunState;
            continue;
          }
          const promptRes = await fetch(`${base}/runs/${runId}/prompts`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ prompt: entry.prompt }),
          });
          if (promptRes.status !== 202 && promptRes.status !== 200) {
            throw new Error(`POST /runs/${runId}/prompts returned ${promptRes.status}, expected 202 or 200`);
          }
          // Restarts here, at this prompt's own acceptance (SPEC.md §3) —
          // not the opening prompt's, and not wherever the previous turn
          // happened to settle.
          const turnAcceptedAt = Date.now();
          const polled = await pollWithinBudget(base, runId, agent.runTimeoutMs ?? 15_000, turnAcceptedAt, maxDurationMs);
          run = polled.run;
          // `turns:` never scripts `abort` (koan.ts rejects it), so unlike
          // the opening submission above there is no abortKind to exempt.
          if (maxDurationMs !== undefined && run.status === 'aborted' && polled.elapsed < maxDurationMs - TIME_LIMIT_EARLY_EPSILON_MS) {
            failures.push(earlyAbortFailure(polled.elapsed, maxDurationMs));
          }
        }
      }

      if (abortKind === 'late') {
        // The run already settled on its own; a late abort must be a
        // no-op, so `then` is judged against the state after it, not the
        // pre-abort state read above.
        const abortRes = await fetch(`${base}/runs/${runId}/abort`, { method: 'POST' });
        if (abortRes.status !== 202 && abortRes.status !== 200) {
          throw new Error(`POST /runs/${runId}/abort returned ${abortRes.status}, expected 202 or 200`);
        }
        const res = await fetch(`${base}/runs/${runId}`);
        if (!res.ok) throw new Error(`GET /runs/${runId} returned ${res.status}`);
        run = (await res.json()) as typeof run;
      }

      failures.push(...llm.state.violations, ...tools.state.violations);

      failures.push(...judgeReportedFolds(trace, run));

      failures.push(...judgeToolTimeouts(koan, trace, llm.state, tools.state.calls));

      // Underruns only: overruns are already recorded by the mocks.
      for (const conv of trace.conversations) {
        const served = llm.state.served[conv.name] ?? 0;
        if (served < conv.turns.length) {
          failures.push(
            `model script not fully consumed${conv.name ? ` for subagent "${conv.name}"` : ''}: ` +
              `${served} of ${conv.turns.length} requests`,
          );
        }
      }
      if (pending.length > 0) {
        failures.push(
          `tool timeline not fully consumed: ${pending.length} permitted invocation(s) never made ` +
            `(${pending.map((p) => `"${p.name}"`).join(', ')})`,
        );
      }

      // The last turn's judgment (or the only one, for a plain `when`/
      // `one_of` koan) — against the fully-settled state, late abort
      // included. Skipped when an earlier turn already stopped the run
      // (`stoppedEarly`): that turn's own judgment above, plus the
      // underrun failures, already cover the koan's failure.
      if (!stoppedEarly) {
        const last = koan.turns?.[koan.turns.length - 1];
        failures.push(...judge(last === undefined ? koan.then : last.kind === 'prompt' ? last.then : {}, run));
      }
    } catch (err) {
      failures.push(err instanceof Error ? err.message : String(err));
    }
  } finally {
    killTree('SIGTERM');
    const killTimer = setTimeout(() => killTree('SIGKILL'), 2_000);
    await waitExit();
    clearTimeout(killTimer);
    fs.rmSync(workspace, { recursive: true, force: true });
    fs.rmSync(stateDir, { recursive: true, force: true });
    await Promise.all([llm.close(), tools.close()]);
  }

  return failures;
}
