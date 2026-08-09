// Runs one koan against one agent implementation: spawns the mocks,
// starts the agent, submits the run, polls to a terminal state, then
// judges the result against `then`. Process orchestration and pass/fail
// aggregation belong here; what to verify is decided by the compiled
// koan and the mocks.
import { spawn, type ChildProcess } from 'node:child_process';
import type { Koan, Matcher, ModelTurn } from './koan.js';
import { startMockLlm } from './mock-llm.js';
import { startMockTools } from './mock-tools.js';
import type { PendingInvocation } from './pending.js';

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
}

const TERMINAL_STATES = new Set(['completed', 'failed', 'aborted']);

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
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

/**
 * Run a koan against an agent: once per trace variant, until one passes.
 * Resolves on conformance; throws with every variant's failures otherwise.
 */
export async function runKoan(koan: Koan, agent: AgentConfig): Promise<void> {
  const variants = Object.entries(koan.traces);
  const allFailures: string[] = [];
  for (const [variant, script] of variants) {
    const failures = await runTrace(koan, script, agent);
    if (failures.length === 0) return;
    allFailures.push(...(variant ? failures.map((f) => `[${variant}] ${f}`) : failures));
  }
  throw new Error(`koan "${koan.name}" failed:\n  - ${allFailures.join('\n  - ')}`);
}

async function runTrace(koan: Koan, script: ModelTurn[], agent: AgentConfig): Promise<string[]> {
  const pending: PendingInvocation[] = [];
  const llm = await startMockLlm(koan, script, pending);
  const tools = await startMockTools(pending);
  const port = await getFreePort();
  const base = `http://127.0.0.1:${port}`;

  const child = spawn('sh', ['-c', agent.command], {
    cwd: agent.cwd,
    env: {
      ...process.env,
      PORT: String(port),
      OPENAI_BASE_URL: `${llm.url}/v1`,
      OPENAI_API_KEY: 'koan-dummy-key',
      KOAN_TOOLS_URL: tools.url,
    },
    stdio: ['ignore', 'inherit', 'inherit'],
    // Own process group, killed as a group below: killing only the
    // direct child leaves the agent's own children (pnpm → sh → node)
    // running and holding the inherited stdio open.
    detached: true,
  });

  const failures: string[] = [];
  try {
    try {
      await waitForHealth(base, agent.startupTimeoutMs ?? 10_000, child);

      const submitRes = await fetch(`${base}/runs`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          task: { prompt: koan.given.task },
          tools: Object.entries(koan.given.tools).map(([name, def]) => ({ name, ...def })),
          ...(koan.given.limits ? { limits: koan.given.limits } : {}),
        }),
      });
      if (submitRes.status !== 201 && submitRes.status !== 202) {
        throw new Error(`POST /runs returned ${submitRes.status}, expected 201 or 202`);
      }
      const { run_id: runId } = (await submitRes.json()) as { run_id?: string };
      if (typeof runId !== 'string' || runId.length === 0) {
        throw new Error('POST /runs response is missing "run_id"');
      }

      const deadline = Date.now() + (agent.runTimeoutMs ?? 15_000);
      let run: { status?: string; output?: string; error?: string } = {};
      for (;;) {
        const res = await fetch(`${base}/runs/${runId}`);
        if (!res.ok) throw new Error(`GET /runs/${runId} returned ${res.status}`);
        run = (await res.json()) as typeof run;
        if (TERMINAL_STATES.has(String(run.status))) break;
        if (Date.now() > deadline) {
          throw new Error(
            `terminal-state guarantee violated: run still "${run.status}" after ${agent.runTimeoutMs ?? 15_000}ms`,
          );
        }
        await sleep(100);
      }

      failures.push(...llm.state.violations, ...tools.state.violations);

      // Underruns only: overruns are already recorded by the mocks.
      if (llm.state.requests.length < script.length) {
        failures.push(
          `model script not fully consumed: ${llm.state.requests.length} of ${script.length} requests`,
        );
      }
      if (pending.length > 0) {
        failures.push(
          `tool timeline not fully consumed: ${pending.length} permitted invocation(s) never made (next: "${pending[0].name}")`,
        );
      }

      if (koan.then.run?.status !== undefined && run.status !== koan.then.run.status) {
        failures.push(
          `run.status: expected "${koan.then.run.status}", got "${run.status}"${run.error ? ` (error: ${run.error})` : ''}`,
        );
      }
      if (koan.then.run?.output !== undefined) {
        const failure = match('run.output', run.output, koan.then.run.output);
        if (failure) failures.push(failure);
      }
    } catch (err) {
      failures.push(err instanceof Error ? err.message : String(err));
    }
  } finally {
    const killTree = (signal: NodeJS.Signals) => {
      if (child.pid === undefined) return;
      try {
        process.kill(-child.pid, signal);
      } catch {
        /* group already gone */
      }
    };
    killTree('SIGTERM');
    const killTimer = setTimeout(() => killTree('SIGKILL'), 2_000);
    await new Promise<void>((r) => {
      if (child.exitCode !== null) return r();
      child.on('exit', () => r());
    });
    clearTimeout(killTimer);
    await Promise.all([llm.close(), tools.close()]);
  }

  return failures;
}
