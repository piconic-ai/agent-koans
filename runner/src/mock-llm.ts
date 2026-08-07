// OpenAI Chat Completions-compatible mock LLM server.
// Answers the Nth request with the Nth `when.model` script entry, and
// records violations of the koan script (SPEC.md §6.1) for later assertion.
// A call_tool entry with tool_responds enqueues the one tool invocation it
// permits onto the shared pending queue (see pending.ts).
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import type { ConversationState, Koan } from './koan.js';
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

/** Classify what the incoming conversation shows (SPEC.md §6.1). */
function classify(messages: ChatMessage[]): ConversationState {
  const last = messages[messages.length - 1];
  if (last?.role === 'tool') {
    // R3: tool failures are reported as tool messages whose content shows
    // a failure indicator. Frameworks phrase this differently ("Error:",
    // "Validation failed", "invalid arguments"), so match the family.
    return /error|fail|invalid/i.test(String(last.content ?? '')) ? 'tool_error' : 'tool_result';
  }
  return 'initial';
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => (data += chunk));
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

export function startMockLlm(koan: Koan, pending: PendingInvocation[]): Promise<MockLlm> {
  const state: MockLlm['state'] = { requests: [], violations: [] };
  const issuedToolCallIds = new Set<string>();
  const script = koan.when.model;
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

    // `expecting` assertion: the Nth request must look like the script says.
    const actual = classify(body.messages ?? []);
    if (entry.expecting && entry.expecting !== actual) {
      state.violations.push(
        `request #${index + 1}: expecting "${entry.expecting}" but the conversation shows "${actual}"`,
      );
    }

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
          args: entry.call_tool.args ?? {},
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
