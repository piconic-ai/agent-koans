// Internal: the scripted stand-in for the tool server, consuming the
// pending queue that mock-llm.ts fills. Anything about model turns
// belongs there, not here.
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { deepEqual, type PendingInvocation } from './pending.js';

interface ToolCallRecord {
  name: string;
  args: unknown;
}

interface MockTools {
  url: string;
  state: {
    calls: ToolCallRecord[];
    violations: string[];
  };
  close(): Promise<void>;
}

// Matches an incoming invocation against the pending set by name — and by
// args when the name repeats, which only happens inside one parallel
// group, since a group with two same-name-same-args members is already a
// load error (koan.ts). FIFO order is deliberately not asserted: SPEC.md
// koan-spec.ts lets the agent execute a group's invocations in any order,
// sequentially or concurrently, so the contract is completeness, not
// arrival order. Everything else about the queue — one entry consumed per
// invocation, extras and unknowns rejected — stays as strict as before.
function takeMatch(pending: PendingInvocation[], name: string, args: unknown): PendingInvocation | undefined {
  const exact = pending.findIndex((p) => p.name === name && deepEqual(p.args, args));
  const idx = exact !== -1 ? exact : pending.findIndex((p) => p.name === name);
  return idx === -1 ? undefined : pending.splice(idx, 1)[0];
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => (data += chunk));
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

/** Serve tool invocations against the pending queue; records calls and violations. */
export function startMockTools(pending: PendingInvocation[]): Promise<MockTools> {
  const state: MockTools['state'] = { calls: [], violations: [] };

  const server = http.createServer(async (req, res) => {
    const respond = (status: number, body: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };

    const match = req.url?.match(/^\/invoke\/([^/?]+)$/);
    if (req.method !== 'POST' || !match) {
      return respond(404, { error: `mock tools: unknown route ${req.method} ${req.url}` });
    }
    const name = decodeURIComponent(match[1]);

    let args: unknown;
    try {
      const raw = await readBody(req);
      args = raw ? JSON.parse(raw) : {};
    } catch {
      state.violations.push(`tool "${name}" was invoked with a non-JSON body`);
      return respond(400, { error: 'invalid JSON body' });
    }

    state.calls.push({ name, args });

    const expected = takeMatch(pending, name, args);
    if (!expected) {
      state.violations.push(
        pending.length === 0
          ? `unexpected invocation of tool "${name}": the timeline permits no tool call here`
          : `unexpected invocation of tool "${name}": the timeline permits only ${pending.map((p) => `"${p.name}"`).join(', ')} here`,
      );
      return respond(500, { error: 'mock tools: no invocation permitted' });
    }
    if (!deepEqual(args, expected.args)) {
      state.violations.push(
        `tool "${name}" received args ${JSON.stringify(args)}, expected ${JSON.stringify(expected.args)}`,
      );
    }

    respond(expected.respond.status, expected.respond.body ?? {});
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo;
      resolve({
        url: `http://127.0.0.1:${port}`,
        state,
        close: () => new Promise((r) => server.close(() => r())),
      });
    });
  });
}
