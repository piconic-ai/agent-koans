// Internal: the scripted stand-in for the OpenAI Chat Completions API,
// and the coherence checks on what the agent sends it — including the
// attribution of interleaved requests to their conversations and the
// information-flow rules between them. Tool invocation
// belongs to mock-tools.ts; pass/fail aggregation to runner.ts.
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { DEFAULT_DELEGATION, type DelegationVocabulary } from './config.js';
import type { Conversation, Koan, ModelTurn, Trace, TurnBoundary } from './koan.js';
import type { PendingInvocation } from './pending.js';

interface ChatMessage {
  role: string;
  content?: string | null | Array<{ type?: string; text?: string }>;
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
    /** Model requests served per conversation name (`''` is the main one). */
    served: Record<string, number>;
    violations: string[];
  };
  close(): Promise<void>;
}

function label(conv: Conversation): string {
  return conv.name === '' ? 'the main conversation' : `subagent "${conv.name}"`;
}

// The conversation's trailing run of tool messages: the closures the
// agent appended for the turn it is answering now. Tool messages further
// back closed earlier turns.
function trailingToolMessages(messages: ChatMessage[]): ChatMessage[] {
  let start = messages.length;
  while (start > 0 && messages[start - 1].role === 'tool') start -= 1;
  return messages.slice(start);
}

function scalarLeaves(value: unknown): string[] {
  if (value === null || value === undefined) return [];
  if (typeof value !== 'object') return [String(value)];
  return Object.values(value as object).flatMap(scalarLeaves);
}

function messageText(msg: ChatMessage): string {
  if (typeof msg.content === 'string') return msg.content;
  if (Array.isArray(msg.content)) {
    return msg.content.map((part) => part.text ?? '').join('\n');
  }
  return '';
}

// The searchable text of a request. Joined from message contents and
// tool_call arguments rather than JSON.stringify-ing the body: JSON
// escaping would make `includes` miss any scripted value containing a
// quote or a backslash.
function requestText(messages: ChatMessage[]): string {
  const parts: string[] = [];
  for (const msg of messages) {
    parts.push(messageText(msg));
    for (const call of msg.tool_calls ?? []) parts.push(call.function.arguments);
  }
  return parts.join('\n');
}

function firstUserText(messages: ChatMessage[]): string {
  const first = messages.find((m) => m.role === 'user');
  return first ? messageText(first) : '';
}

// The wire `tool_call_id`s of one turn's instructions, tool calls first,
// then delegations. The main conversation's single-instruction turns keep
// the plain `call_N` id (no behavioral reason, just avoids churning ids
// that earlier koans' failure messages might quote); subagent turns carry
// the conversation name so every id stays unique within the run.
function callIdsFor(conv: Conversation, turnIndex: number): string[] {
  const turn = conv.turns[turnIndex];
  const count = (turn.call_tools?.length ?? 0) + (turn.delegations?.length ?? 0);
  const base = conv.name === '' ? `call_${turnIndex + 1}` : `call_${conv.name}_${turnIndex + 1}`;
  return count === 1 ? [base] : Array.from({ length: count }, (_, j) => `${base}_${j + 1}`);
}

interface ConversationScript {
  conv: Conversation;
  served: number;
  /** Values whose appearance in another conversation's request is a leak, with their source rule. */
  forbidden: Array<{ value: string; reason: string }>;
}

// Builds the negative information-flow sets. Every value
// scripted into one conversation is forbidden from appearing in every
// other conversation's requests, with one exception: a value that is
// also legitimately visible *in the target* (its own `allowed` set,
// below) is dropped, since `includes` could not tell the two apart from
// a leaked one. This is what makes a crossing sanctioned, by construction
// rather than by hand-picking which value kinds cross which relation: a
// child's briefing is visible to the parent that issued it (the parent's
// own `issuedPrompts`), a child's final reply is visible to the parent
// that received it (`receivedFinals`), and both are visible to the child
// itself (its own openings/replies) — nothing else needs to single out
// parent/child/sibling cases, or omit a value kind (file contents, most
// notably) from one of them by oversight.
function buildForbidden(trace: Trace): Map<string, ConversationScript['forbidden']> {
  // Every user turn's prompt, not just the first: a `turns:` koan's main
  // conversation opens more than one (conv.followUps).
  const openings = (conv: Conversation): string[] => [
    conv.briefing,
    ...(conv.followUps?.map((f) => f.prompt) ?? []),
  ];
  const replies = (conv: Conversation): string[] =>
    conv.turns.map((t) => t.reply).filter((r): r is string => r !== undefined);
  const toolScalars = (conv: Conversation): string[] =>
    conv.turns.flatMap((t) =>
      (t.call_tools ?? []).flatMap((m) => (m.tool_responds ? scalarLeaves(m.tool_responds.body) : [])),
    );
  const fileContents = (conv: Conversation): string[] =>
    conv.turns.flatMap((t) => (t.call_tools ?? []).flatMap((m) => (m.readsFile !== undefined ? [m.readsFile] : [])));
  const issuedPrompts = (conv: Conversation): string[] =>
    conv.turns.flatMap((t) => (t.delegations ?? []).map((d) => d.prompt));
  const receivedFinals = (conv: Conversation): string[] =>
    conv.turns.flatMap((t) => (t.delegations ?? []).map((d) => d.final));

  const allowed = new Map<string, string[]>();
  for (const conv of trace.conversations) {
    allowed.set(conv.name, [
      ...openings(conv),
      ...replies(conv),
      ...toolScalars(conv),
      ...fileContents(conv),
      ...issuedPrompts(conv),
      ...receivedFinals(conv),
    ]);
  }

  const forbidden = new Map<string, ConversationScript['forbidden']>();
  for (const target of trace.conversations) {
    const entries: ConversationScript['forbidden'] = [];
    for (const source of trace.conversations) {
      if (source.name === target.name) continue;
      const values = allowed.get(source.name) ?? [];
      const visible = allowed.get(target.name) ?? [];
      for (const value of new Set(values)) {
        if (value.length === 0) continue;
        if (visible.some((a) => a.includes(value))) continue;
        entries.push({ value, reason: `a value scripted only into ${label(source)}` });
      }
    }
    forbidden.set(target.name, entries);
  }
  return forbidden;
}

// Never matched against wording: failure phrasing is framework-specific,
// so only values the mock itself scripted are looked for.
//
// Within the conversation's trailing run of tool messages, closures are
// matched by id rather than by position: the agent may close a parallel
// group's calls in any order, so "the last message" is not
// a meaningful thing to inspect once more than one call can be open at
// once. The run itself still has to be trailing — a conversation that
// continues past the closures is calling the model with something other
// than the tool results.
function checkCoherence(
  conv: Conversation,
  index: number,
  requestNo: number,
  messages: ChatMessage[],
  violations: string[],
): void {
  const prev = conv.turns[index - 1];
  // Compile-time guarantees prev has instructions here: a model request
  // can never follow a text reply within one conversation (koan.ts
  // rejects that trace shape), and a conversation's first request is
  // checked separately (checkConversationStart).
  const group = prev.call_tools ?? [];
  const delegations = prev.delegations ?? [];
  const ids = callIdsFor(conv, index - 1);
  const names = [...group.map((m) => m.name), ...delegations.map((d) => `the delegation to "${d.subagent}"`)];
  const trailing = trailingToolMessages(messages);

  if (trailing.length === 0) {
    violations.push(
      `request #${requestNo} must close the pending tool call${ids.length > 1 ? 's' : ''} with a tool message, ` +
        `but its last message has role "${messages[messages.length - 1]?.role}"`,
    );
    return;
  }

  const byId = new Map(trailing.map((m) => [m.tool_call_id, m]));
  const text = requestText(messages);

  for (const [i, id] of ids.entries()) {
    const msg = byId.get(id);
    if (!msg) {
      violations.push(
        `request #${requestNo} must close tool call "${id}" (${names[i]}) with a tool message before calling the model again`,
      );
      continue;
    }
    if (i >= group.length) continue; // a delegation's result is checked below, request-wide
    const member = group[i];
    if (member.readsFile !== undefined && !text.includes(member.readsFile)) {
      violations.push(
        `request #${requestNo}: the content of given.files["${String(member.args?.path)}"] did not reach the model — ` +
          `the internal "${member.name}" read must flow into the conversation's next request`,
      );
    }
    // No content check for other refused calls: self-generated report
    // phrasing is implementation-specific.
    const responds = member.tool_responds;
    if (!responds) continue;

    const { status, body } = responds;
    const failed = status >= 400;
    const indicators = failed ? [String(status), ...scalarLeaves(body)] : scalarLeaves(body);
    if (indicators.length === 0) continue;

    const content = messageText(msg);
    if (!indicators.some((s) => content.includes(s))) {
      violations.push(
        `request #${requestNo}: the tool ${failed ? `failure (status ${status})` : 'result'} for "${member.name}" did not reach ` +
          `the model — the tool message carries none of ${JSON.stringify(indicators)}`,
      );
    }
  }

  // Positive flow: each delegate's final reply must reach
  // the parent's next model request — for parallel delegations, every
  // sibling's, which is what makes the parent join all of them.
  for (const d of delegations) {
    if (!text.includes(d.final)) {
      violations.push(
        `request #${requestNo}: subagent "${d.subagent}"'s final reply did not reach ${label(conv)} — ` +
          `the delegation must be closed with the child's final answer`,
      );
    }
  }
}

// A conversation's first request needs no content check beyond this: the
// opening briefing is what routed the request here (see `route`, below),
// so re-asserting its presence would be redundant.
function checkConversationStart(
  conv: Conversation,
  requestNo: number,
  messages: ChatMessage[],
  violations: string[],
): void {
  if (messages[messages.length - 1]?.role === 'tool') {
    violations.push(`request #${requestNo} opens ${label(conv)}, but its last message is a tool message`);
  }
}

// Everything a `turns:` koan's conversation scripted
// before `uptoIndex`: every earlier turn's opening prompt, replies, tool
// response scalars, internal reads, and delegation finals — what a later
// turn's first request must still carry, the same positive-flow style as
// a subagent's final reply crossing into its parent.
function turnValues(conv: Conversation, uptoIndex: number): string[] {
  const values: string[] = [conv.briefing];
  for (const f of conv.followUps ?? []) {
    if (f.start < uptoIndex) values.push(f.prompt);
  }
  for (const turn of conv.turns.slice(0, uptoIndex)) {
    if (turn.reply !== undefined) values.push(turn.reply);
    for (const member of turn.call_tools ?? []) {
      if (member.tool_responds) values.push(...scalarLeaves(member.tool_responds.body));
      if (member.readsFile !== undefined) values.push(member.readsFile);
    }
    for (const d of turn.delegations ?? []) values.push(d.final);
  }
  return values;
}

// The request that opens turn 2+ of a `turns:` koan: it
// must carry the new turn's prompt, plus everything scripted into every
// earlier turn — the run-level counterpart of a subagent's continuation
// history, before that was cut back to one delegation per name.
function checkTurnBoundary(
  conv: Conversation,
  boundary: TurnBoundary,
  requestNo: number,
  messages: ChatMessage[],
  violations: string[],
): void {
  if (messages[messages.length - 1]?.role === 'tool') {
    violations.push(`request #${requestNo} opens a new turn of ${label(conv)}, but its last message is a tool message`);
  }
  const text = requestText(messages);
  if (!text.includes(boundary.prompt)) {
    violations.push(`request #${requestNo}: the new turn's prompt is missing from the request`);
  }
  for (const value of turnValues(conv, boundary.start)) {
    if (!text.includes(value)) {
      violations.push(
        `request #${requestNo}: a follow-up must carry the earlier turns' history — ${JSON.stringify(value)} is missing`,
      );
    }
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
  trace: Trace,
  pending: PendingInvocation[],
  delegation: DelegationVocabulary = DEFAULT_DELEGATION,
): Promise<MockLlm> {
  const state: MockLlm['state'] = { requests: [], served: {}, violations: [] };
  const issuedToolCallIds = new Set<string>();
  const givenToolNames = Object.keys(koan.given.tools);
  const scripts = trace.conversations.map((conv): ConversationScript => ({ conv, served: 0, forbidden: [] }));
  const forbidden = buildForbidden(trace);
  for (const script of scripts) {
    script.forbidden = forbidden.get(script.conv.name) ?? [];
    state.served[script.conv.name] = 0;
  }
  const main = scripts[0];
  // A live abort means the runner cancels the run right after this
  // script is fully served; a request beyond it is the agent racing that
  // cancellation, not a bug, so it must not be scored as an overrun.
  const liveAbort = main.conv.turns.at(-1)?.abort === 'live';

  // Requests are attributed to conversations by content: the first user
  // message carries the task (main) or a briefing (that subagent), and
  // the loader guarantees no opening contains another. Routing on a
  // per-conversation `model` field ("model: koan/<name>") remains a
  // possible future alternative, but it would change the run contract
  // and require frameworks to register one provider entry per delegate;
  // expectation matching needs neither, and the briefing arriving
  // verbatim as the child's first user message is measured behavior.
  const route = (messages: ChatMessage[]): ConversationScript | undefined => {
    const opening = firstUserText(messages);
    return scripts.find((s) => opening.includes(s.conv.briefing));
  };

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
    const requestNo = state.requests.length;
    const messages = body.messages ?? [];

    const script = route(messages);
    if (!script) {
      state.violations.push(
        `request #${requestNo} matches no scripted conversation — its first user message carries neither the task nor any briefing`,
      );
      return respond(400, { error: { message: 'mock LLM: request matches no scripted conversation' } });
    }
    const conv = script.conv;
    const index = script.served;
    const entry = conv.turns[index];

    if (!entry) {
      if (liveAbort && conv.name === '') {
        // The world stops answering once the pre-abort script is served:
        // hold the connection open rather than reject it. This request is
        // either racing the caller's abort or arriving after it already
        // landed — both converge on the run having nothing left to wait
        // for but its own abort settling.
        return;
      }
      state.violations.push(
        `${label(conv)} called the model ${index + 1} times but its script has only ${conv.turns.length} entries`,
      );
      return respond(400, { error: { message: 'mock LLM: script exhausted' } });
    }
    script.served += 1;
    state.served[conv.name] = script.served;

    if (givenToolNames.length > 0) {
      const offered = new Set(
        (body.tools ?? []).map((t) => t.function?.name).filter(Boolean),
      );
      for (const name of givenToolNames) {
        if (!offered.has(name)) {
          state.violations.push(
            `request #${requestNo} is missing the definition of tool "${name}"`,
          );
        }
      }
    }

    for (const msg of trailingToolMessages(messages)) {
      if (!issuedToolCallIds.has(String(msg.tool_call_id))) {
        state.violations.push(
          `request #${requestNo} has a tool message with unknown tool_call_id "${msg.tool_call_id}"`,
        );
      }
    }

    const followUp = conv.followUps?.find((f) => f.start === index);
    if (index === 0) {
      checkConversationStart(conv, requestNo, messages, state.violations);
    } else if (followUp) {
      checkTurnBoundary(conv, followUp, requestNo, messages, state.violations);
    } else {
      checkCoherence(conv, index, requestNo, messages, state.violations);
    }

    // Negative flow: nothing scripted exclusively into
    // another conversation may surface here.
    const text = requestText(messages);
    for (const { value, reason } of script.forbidden) {
      if (text.includes(value)) {
        state.violations.push(
          `request #${requestNo} (${label(conv)}) carries ${JSON.stringify(value)}, ${reason} — ` +
            `information crosses conversations only through a briefing or a final reply`,
        );
      }
    }

    if (entry.fails) {
      // A scripted API failure is a plain JSON error even for stream
      // requests: that is how the real endpoint rejects before streaming.
      return respond(
        entry.fails.status,
        entry.fails.body ?? {
          error: { message: 'mock LLM: scripted API failure', type: 'invalid_request_error' },
        },
      );
    }

    let message: ChatMessage;
    let finishReason: string;
    if (entry.call_tools || entry.delegations) {
      const ids = callIdsFor(conv, index);
      const callTools = entry.call_tools ?? [];
      const delegations = entry.delegations ?? [];
      callTools.forEach((member, j) => {
        issuedToolCallIds.add(ids[j]);
        if (member.tool_responds) {
          pending.push({
            name: member.name,
            args: member.invokeArgs ?? member.args ?? {},
            respond: member.tool_responds,
          });
        }
      });
      delegations.forEach((_, j) => issuedToolCallIds.add(ids[callTools.length + j]));
      message = {
        role: 'assistant',
        content: null,
        tool_calls: [
          ...callTools.map((member, j) => ({
            id: ids[j],
            type: 'function',
            // The wire string, verbatim — this is what carries a
            // malformed-arguments koan's unparseable string through to the
            // agent.
            function: { name: member.name, arguments: member.argsWire },
          })),
          // A delegation is emitted in the implementation's declared
          // vocabulary: the mock plays the model, so the
          // tool_call must be one the framework's runtime executes as a
          // delegation.
          ...delegations.map((d, j) => ({
            id: ids[callTools.length + j],
            type: 'function',
            function: {
              name: delegation.tool,
              arguments: JSON.stringify({ [delegation.agent_arg]: d.subagent, [delegation.prompt_arg]: d.prompt }),
            },
          })),
        ],
      };
      finishReason = 'tool_calls';
    } else {
      message = { role: 'assistant', content: entry.reply ?? '' };
      finishReason = 'stop';
    }

    const id = `chatcmpl-koan-${requestNo}`;
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
