// Mock tool server. Serves POST /invoke/{name} from the koan's
// `when.tools` script and records every invocation for assertions.
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Koan } from './koan.js';

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

export function startMockTools(koan: Koan): Promise<MockTools> {
  const state: MockTools['state'] = { calls: [], violations: [] };
  const scripts = koan.when.tools ?? {};
  const consumed: Record<string, number> = {};

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

    const script = scripts[name];
    if (!script) {
      // R7: this tool should never have been invoked.
      state.violations.push(`tool "${name}" was invoked but has no scripted responses`);
      return respond(404, { error: `unknown tool "${name}"` });
    }

    const index = consumed[name] ?? 0;
    consumed[name] = index + 1;
    const entry = script[index];
    if (!entry) {
      // Catches implicit retries (R4): more invocations than scripted.
      state.violations.push(
        `tool "${name}" was invoked ${index + 1} times but the script has only ${script.length} responses`,
      );
      return respond(500, { error: 'mock tools: script exhausted' });
    }

    respond(entry.respond.status, entry.respond.body ?? {});
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
