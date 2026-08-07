// OpenAI Chat Completions-compatible mock LLM server.
// Answers the Nth request with the Nth `when.model` script entry, and
// records violations of the koan script (SPEC.md §6.1) for later assertion.
// A call_tool entry with tool_responds enqueues the one tool invocation it
// permits onto the shared pending queue (see pending.ts).
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

export interface MockLlm {
  /** Base URL without the /v1 prefix. */
  url: string;
  state: {
    requests: ChatRequest[];
    violations: string[];
  };
  close(): Promise<void>;
}

/** All scalar leaf values of a JSON value, stringified. */
function scalarLeaves(value: unknown): string[] {
  if (value === null || value === undefined) return [];
  if (typeof value !== 'object') return [String(value)];
  return Object.values(value as object).flatMap(scalarLeaves);
}

/**
 * Conversation coherence (SPEC.md §6.1), verified by information flow
 * rather than vocabulary: the mock produced the tool response, so it
 * knows what content must have reached the model. For a tool failure the
 * report must carry the status code or the error body's content (R3);
 * for a success the result must carry the response body's content (R2).
 * A refused call (no tool request scripted) is checked structurally only.
 */
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

  // The loader guarantees a model request only follows a tool-call
  // instruction (multi-turn traces are not supported yet).
  if (last?.role !== 'tool') {
    violations.push(
      `request #${index + 1} must close the pending tool call, but its last message has role "${last?.role}"`,
    );
    return;
  }
  if (!prev.tool_responds) return; // refused call: structural check only

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

    // R1: tool definitions must be forwarded on every request.
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

    // R2: tool messages must reference a tool_call_id we actually issued.
    const last = body.messages?.[body.messages.length - 1];
    if (last?.role === 'tool' && !issuedToolCallIds.has(String(last.tool_call_id))) {
      state.violations.push(
        `request #${index + 1} has a tool message with unknown tool_call_id "${last.tool_call_id}" (R2)`,
      );
    }

    // Conversation coherence: the Nth request must reflect the trace so far.
    checkCoherence(index, script, body.messages ?? [], state.violations);

    // Respond with the scripted action.
    let message: ChatMessage;
    let finishReason: string;
    if (entry.call_tool) {
      const id = `call_${index + 1}`;
      issuedToolCallIds.add(id);
      // Permit (and require) the one invocation this call provokes.
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
      // OpenAI-compatible SSE streaming: one delta chunk carrying the whole
      // message, a finish chunk, then [DONE].
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
