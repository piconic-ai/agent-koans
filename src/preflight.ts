// Preflight: start the agent once before any koan and diagnose the two
// common misconfigurations — a command that cannot start at all, and a
// server that never answers GET /health — so a wrong --agent fails in
// seconds with its reason, instead of as one identical timeout per koan.
// Only startability and the health probe are judged here; everything
// behind /health is what the koans are for. The agent's output is
// captured (not inherited, as the runner does) because it is the
// diagnosis: a crash's stack trace names the real problem.
import { spawn } from 'node:child_process';
import { getFreePort, type AgentConfig } from './runner.js';

const OUTPUT_CAP = 8_192;

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Start the agent once and probe `GET /health`. Resolves to `null` when
 * the agent answers 200 within the startup timeout, otherwise to a
 * human-readable diagnosis of why it did not — the process's exit code
 * and captured output, or the never-healthy address. The probe uses
 * placeholder model/tool URLs: preflight ends before any run is
 * submitted, so they are never called.
 */
export async function preflight(agent: AgentConfig): Promise<string | null> {
  const port = await getFreePort();
  const timeoutMs = agent.startupTimeoutMs ?? 10_000;
  const child = spawn('sh', ['-c', agent.command], {
    cwd: agent.cwd,
    env: {
      ...process.env,
      PORT: String(port),
      OPENAI_BASE_URL: 'http://127.0.0.1:9/v1',
      OPENAI_API_KEY: 'koan-dummy-key',
      KOAN_TOOLS_URL: 'http://127.0.0.1:9',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true,
  });

  let output = '';
  const collect = (chunk: Buffer) => {
    output = (output + chunk.toString()).slice(-OUTPUT_CAP);
  };
  child.stdout?.on('data', collect);
  child.stderr?.on('data', collect);

  const killTree = (signal: NodeJS.Signals) => {
    if (child.pid === undefined) return;
    try {
      process.kill(-child.pid, signal);
    } catch {
      /* group already gone */
    }
  };

  const outputSection = () =>
    output.trim() === '' ? '' : `\nthe agent's output:\n${output.trim()}`;

  try {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (child.exitCode !== null) {
        return `the command exited with code ${child.exitCode} before answering GET /health${outputSection()}`;
      }
      try {
        const res = await fetch(`http://127.0.0.1:${port}/health`);
        if (res.ok) return null;
      } catch {
        /* not up yet */
      }
      await sleep(100);
    }
    return (
      `the process is running but never answered GET /health on ` +
      `http://127.0.0.1:${port} within ${timeoutMs}ms — does the server ` +
      `read PORT from the environment?${outputSection()}`
    );
  } finally {
    killTree('SIGTERM');
    const killTimer = setTimeout(() => killTree('SIGKILL'), 2_000);
    await new Promise<void>((r) => {
      if (child.exitCode !== null) return r();
      child.on('exit', () => r());
    });
    clearTimeout(killTimer);
  }
}
