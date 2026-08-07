import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { deepEqual, type PendingInvocation } from './pending.js';

export interface ToolCallRecord {
  name: string;
  args: unknown;
}

export interface MockTools {
  url: string;
  state: {
    calls: ToolCallRecord[];
    violations: string[];
  };
  close(): Promise<void>;
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => (data += chunk));
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

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

    const expected = pending.shift();
    if (!expected) {
      state.violations.push(
        `unexpected invocation of tool "${name}": the timeline permits no tool call here`,
      );
      return respond(500, { error: 'mock tools: no invocation permitted' });
    }
    if (expected.name !== name) {
      state.violations.push(
        `expected invocation of tool "${expected.name}" but got "${name}"`,
      );
      return respond(500, { error: `mock tools: expected "${expected.name}"` });
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
