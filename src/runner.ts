// Runs one koan against one agent implementation: spawns the mocks,
// starts the agent, submits the run, polls to a terminal state, then
// judges the result against `then`. Process orchestration and pass/fail
// aggregation belong here; what to verify is decided by the compiled
// koan and the mocks.
import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { DelegationVocabulary } from './config.js';
import { promptDuringOf, type Judgment, type Koan, type Matcher, type Trace } from './koan.js';
import { startMockLlm } from './mock-llm.js';
import { startMockTools } from './mock-tools.js';
import { createHold, type PendingInvocation } from './pending.js';

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
async function pollToTerminal(
  base: string,
  runId: string,
  runTimeoutMs: number,
  settled?: () => boolean,
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
      throw new Error(`terminal-state guarantee violated: run still "${run.status}" after ${runTimeoutMs}ms`);
    }
    await sleep(100);
  }
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

// What the caller was told about the folds the trace scripts (SPEC.md
// §3). Read from the settled run rather than watched as it happens: a
// client polls, so the record has to survive the activity it describes.
function judgeReportedFolds(trace: Trace, run: RunState): string[] {
  const folds = trace.conversations.reduce((n, c) => n + c.turns.filter((t) => t.compaction).length, 0);
  const reported = (run.events ?? []).filter((e) => e.type === 'compaction');
  const expected = Array.from({ length: folds }, () => ['started', 'completed']).flat();
  const actual = reported.map((e) => String(e.phase));
  if (actual.length === expected.length && actual.every((phase, i) => phase === expected[i])) return [];
  const detail = reported.map((e) => `${e.phase}${e.error ? ` (${e.error})` : ''}`).join(', ') || 'nothing';
  return [
    `the run reported ${detail} to its caller, but the trace folds the conversation down ${folds} time(s): ` +
      `GET /runs/{run_id} must carry a "compaction" event when a fold starts and one when it ends`,
  ];
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
  // Created here rather than inside a mock: both it and this driver hold
  // one end of the same window.
  const promptDuring = promptDuringOf(trace);
  const hold = promptDuring !== undefined ? createHold() : undefined;
  const llm = await startMockLlm(koan, trace, pending, agent.delegation, hold);
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
  let child: ChildProcess | undefined;

  const failures: string[] = [];
  try {
    try {
      for (const [rel, content] of Object.entries(koan.given.files ?? {})) {
        const dest = path.join(workspace, rel);
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        fs.writeFileSync(dest, content);
      }

      child = spawn('sh', ['-c', agent.command], {
        cwd: agent.cwd,
        env: {
          ...process.env,
          PORT: String(port),
          OPENAI_BASE_URL: `${llm.url}/v1`,
          OPENAI_API_KEY: 'koan-dummy-key',
          KOAN_TOOLS_URL: tools.url,
          KOAN_WORKSPACE: workspace,
        },
        stdio: ['ignore', 'inherit', 'inherit'],
        // Own process group, killed as a group below: killing only the
        // direct child leaves the agent's own children (pnpm → sh → node)
        // running and holding the inherited stdio open.
        detached: true,
      });

      await waitForHealth(base, agent.startupTimeoutMs ?? 10_000, child);

      // A `turns:` koan submits its first turn's prompt the
      // same way any koan submits its top-level `prompt`; later turns go
      // to POST /runs/{id}/prompts instead.
      const firstPrompt = koan.turns ? koan.turns[0].prompt : (koan.prompt as string);

      const submitRes = await fetch(`${base}/runs`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          prompt: firstPrompt,
          tools: Object.entries(koan.given.tools).map(([name, def]) => ({ name, ...def })),
          ...(subagentNames.length > 0 ? { subagents: subagentNames.map((name) => ({ name })) } : {}),
          ...(koan.given.limits ? { limits: koan.given.limits } : {}),
          ...(koan.given.context ? { context: koan.given.context } : {}),
        }),
      });
      if (submitRes.status !== 201 && submitRes.status !== 202) {
        throw new Error(`POST /runs returned ${submitRes.status}, expected 201 or 202`);
      }
      const { run_id: runId } = (await submitRes.json()) as { run_id?: string };
      if (typeof runId !== 'string' || runId.length === 0) {
        throw new Error('POST /runs response is missing "run_id"');
      }

      // A `turns:` koan never scripts `abort` (koan.ts rejects it), so
      // abortKind is always undefined for one — this whole branch is
      // unreached and the run-timeout deadline below serves only the
      // live-abort wait.
      const abortKind = trace.conversations[0].turns.at(-1)?.abort;
      const deadline = Date.now() + (agent.runTimeoutMs ?? 15_000);

      if (abortKind === 'live') {
        // Fire the abort exactly when the trace says the caller does: as
        // soon as every step before it has been observed on the wire. A
        // request that then races ahead of the abort landing is parked by
        // the mock (mock-llm.ts), not rejected here — so whichever one
        // wins, the run has nothing left to do but settle aborted.
        while (!(llm.state.requests.length >= totalTurns && pending.length === 0)) {
          if (Date.now() > deadline) {
            throw new Error(
              `abort trace's pre-abort steps were not fully observed within ${agent.runTimeoutMs ?? 15_000}ms: ` +
                `${llm.state.requests.length}/${totalTurns} model requests served, ${pending.length} tool call(s) still unresolved`,
            );
          }
          await sleep(100);
        }
        const abortRes = await fetch(`${base}/runs/${runId}/abort`, { method: 'POST' });
        if (abortRes.status !== 202 && abortRes.status !== 200) {
          throw new Error(`POST /runs/${runId}/abort returned ${abortRes.status}, expected 202 or 200`);
        }
      }

      if (promptDuring !== undefined && hold) {
        await within(
          hold.engaged,
          Date.now() + (agent.runTimeoutMs ?? 15_000),
          () =>
            `the tool invocation the trace holds open was never made within ${agent.runTimeoutMs ?? 15_000}ms, ` +
            `so the mid-run prompt was never sent`,
        );
        try {
          const promptRes = await fetch(`${base}/runs/${runId}/prompts`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ prompt: promptDuring }),
          });
          if (promptRes.status !== 202 && promptRes.status !== 200) {
            throw new Error(
              `POST /runs/${runId}/prompts returned ${promptRes.status} for a run still running, expected 202 or 200`,
            );
          }
        } finally {
          // Released even on failure: the tool mock is parked on this,
          // and its server cannot close until it returns.
          hold.release();
        }
      }

      const scriptConsumed = () =>
        trace.conversations.every((c) => (llm.state.served[c.name] ?? 0) >= c.turns.length) && pending.length === 0;

      let run = await pollToTerminal(
        base,
        runId,
        agent.runTimeoutMs ?? 15_000,
        promptDuring !== undefined ? scriptConsumed : undefined,
      );

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
      if (koan.turns) {
        for (let t = 0; t < koan.turns.length - 1; t++) {
          failures.push(...judge(koan.turns[t].then, run));
          if (run.status !== 'completed') {
            stoppedEarly = true;
            failures.push(
              `turn ${t + 1} of ${koan.turns.length} did not complete; the remaining prompts were not sent`,
            );
            break;
          }
          const promptRes = await fetch(`${base}/runs/${runId}/prompts`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ prompt: koan.turns[t + 1].prompt }),
          });
          if (promptRes.status !== 202 && promptRes.status !== 200) {
            throw new Error(`POST /runs/${runId}/prompts returned ${promptRes.status}, expected 202 or 200`);
          }
          run = await pollToTerminal(base, runId, agent.runTimeoutMs ?? 15_000);
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
        failures.push(...judge(koan.turns ? koan.turns[koan.turns.length - 1].then : koan.then, run));
      }
    } catch (err) {
      failures.push(err instanceof Error ? err.message : String(err));
    }
  } finally {
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
    killTree('SIGTERM');
    const killTimer = setTimeout(() => killTree('SIGKILL'), 2_000);
    await new Promise<void>((r) => {
      if (!child || child.exitCode !== null) return r();
      child.on('exit', () => r());
    });
    clearTimeout(killTimer);
    fs.rmSync(workspace, { recursive: true, force: true });
    await Promise.all([llm.close(), tools.close()]);
  }

  return failures;
}
