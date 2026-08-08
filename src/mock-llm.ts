// Internal: the scripted stand-in for the OpenAI Chat Completions API,
// and the coherence checks on what the agent sends it. Tool invocation
// belongs to mock-tools.ts; pass/fail aggregation to runner.ts.
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Koan, ModelTurn } from './koan.js';
import type { PendingInvocation } from './pending.js';

interface ChatMessage {
  role: string;
  content?: string | null;
  tool_call_id?: string;
  tool_calls?: Array<{
    id: string;
    type: string;
    function: { name: string; arguments: string };
  }>;
}

interface ChatRequest {
  messages: ChatMessage[];
  tools?: Array<{ type: string; function?: { name: string } }>;
  stream?: boolean;
}

interface MockLlm {
  url: string;
  state: {
    requests: ChatRequest[];
    violations: string[];
  };
  close(): Promise<void>;
}

function scalarLeaves(value: unknown): string[] {
  if (value === null || value === undefined) return [];
  if (typeof value !== 'object') return [String(value)];
  return Object.values(value as object).flatMap(scalarLeaves);
}

// Never matched against wording: failure phrasing is framework-specific,
// so only values the mock itself scripted are looked for (SPEC.md §6.1).
function checkCoherence(
  index: number,
  script: ModelTurn[],
  messages: ChatMessage[],
  violations: string[],
): void {
  const last = messages[messages.length - 1];
  const prev = index > 0 ? script[index - 1] : undefined;

  if (!prev) {
    if (last?.role === 'tool') {
      violations.push('request #1 must carry the task, but its last message is a tool message');
    }
    return;
  }

  if (last?.role !== 'tool') {
    violations.push(
      `request #${index + 1} must close the pending tool call, but its last message has role "${last?.role}"`,
    );
    return;
  }
  // No content check for refused calls: self-generated report phrasing
  // is implementation-specific (SPEC.md §4 R3).
  if (!prev.tool_responds) return;

  const { status, body } = prev.tool_responds;
  const failed = status >= 400;
  const indicators = failed ? [String(status), ...scalarLeaves(body)] : scalarLeaves(body);
  if (indicators.length === 0) return;

  const content = String(last.content ?? '');
  if (!indicators.some((s) => content.includes(s))) {
    violations.push(
      `request #${index + 1}: the tool ${failed ? `failure (status ${status})` : 'result'} did not reach ` +
        `the model — the tool message carries none of ${JSON.stringify(indicators)} (${failed ? 'R3' : 'R2'})`,
    );
  }
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => (data += chunk));
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

/** Serve one trace's model turns; records requests and violations. */
export function startMockLlm(
  koan: Koan,
  script: ModelTurn[],
  pending: PendingInvocation[],
): Promise<MockLlm> {
  const state: MockLlm['state'] = { requests: [], violations: [] };
  const issuedToolCallIds = new Set<string>();
  const givenToolNames = Object.keys(koan.given.tools);

  const server = http.createServer(async (req, res) => {
    const respond = (status: number, body: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };

    if (req.method !== 'POST' || !req.url?.endsWith('/chat/completions')) {
      return respond(404, { error: { message: `mock LLM: unknown route ${req.method} ${req.url}` } });
    }

    let body: ChatRequest;
    try {
      body = JSON.parse(await readBody(req)) as ChatRequest;
    } catch {
      state.violations.push('model request body is not valid JSON');
      return respond(400, { error: { message: 'invalid JSON' } });
    }

    state.requests.push(body);
    const index = state.requests.length - 1;
    const entry = script[index];

    if (!entry) {
      state.violations.push(
        `model was called ${state.requests.length} times but the script has only ${script.length} entries`,
      );
      return respond(400, { error: { message: 'mock LLM: script exhausted' } });
    }

    if (givenToolNames.length > 0) {
      const offered = new Set(
        (body.tools ?? []).map((t) => t.function?.name).filter(Boolean),
      );
      for (const name of givenToolNames) {
        if (!offered.has(name)) {
          state.violations.push(
            `request #${index + 1} is missing the definition of tool "${name}" (R1)`,
          );
        }
      }
    }

    const last = body.messages?.[body.messages.length - 1];
    if (last?.role === 'tool' && !issuedToolCallIds.has(String(last.tool_call_id))) {
      state.violations.push(
        `request #${index + 1} has a tool message with unknown tool_call_id "${last.tool_call_id}" (R2)`,
      );
    }

    checkCoherence(index, script, body.messages ?? [], state.violations);

    let message: ChatMessage;
    let finishReason: string;
    if (entry.call_tool) {
      const id = `call_${index + 1}`;
      issuedToolCallIds.add(id);
      if (entry.tool_responds) {
        pending.push({
          name: entry.call_tool.name,
          args: entry.invoke_args ?? entry.call_tool.args ?? {},
          respond: entry.tool_responds,
        });
      }
      message = {
        role: 'assistant',
        content: null,
        tool_calls: [
          {
            id,
            type: 'function',
            function: {
              name: entry.call_tool.name,
              arguments: JSON.stringify(entry.call_tool.args ?? {}),
            },
          },
        ],
      };
      finishReason = 'tool_calls';
    } else {
      message = { role: 'assistant', content: entry.reply ?? '' };
      finishReason = 'stop';
    }

    const id = `chatcmpl-koan-${index + 1}`;
    const usage = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };

    if (body.stream) {
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
      });
      const chunk = (payload: unknown) => res.write(`data: ${JSON.stringify(payload)}\n\n`);
      const base = { id, object: 'chat.completion.chunk', created: 0, model: 'agent-koans-mock' };
      const delta: Record<string, unknown> = { role: 'assistant' };
      if (message.tool_calls) {
        delta.tool_calls = message.tool_calls.map((tc, i) => ({ index: i, ...tc }));
      } else {
        delta.content = message.content ?? '';
      }
      chunk({ ...base, choices: [{ index: 0, delta, finish_reason: null }] });
      chunk({ ...base, choices: [{ index: 0, delta: {}, finish_reason: finishReason }], usage });
      res.write('data: [DONE]\n\n');
      res.end();
      return;
    }

    respond(200, {
      id,
      object: 'chat.completion',
      created: 0,
      model: 'agent-koans-mock',
      choices: [{ index: 0, message, finish_reason: finishReason }],
      usage,
    });
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
