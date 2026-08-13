// The loop: ask the model, run what it asked for, ask again. What belongs
// here is the order those steps happen in and what ends them; what does
// not is how any one step is carried out — the model request, a tool, a
// fold, and the budget each keep their own file.
//
// No agent framework anywhere below it. This loop, and the run lifecycle
// that drives it, are the part agent-koans verifies.
import type { Budget } from './budget.js';
import { fold, type ReportEvent } from './compaction.js';
import type { ChatMessage, ModelClient, ToolCall } from './model.js';
import type { Tool } from './tools.js';
import { checkRoom, reachedThreshold, type ConversationSize, type RunContext } from './window.js';

/** One conversation of a run: a history of its own, and a size of its own. */
export interface Conversation {
  messages: ChatMessage[];
  /**
   * What the endpoint last reported this conversation to have reached
   * (SPEC.md §3). Kept with the history rather than per turn: a turn
   * starting over from zero would carry a full window into itself.
   */
  size: ConversationSize;
}

/**
 * What every conversation of one run shares. A delegate is given a
 * `Conversation` of its own and this same scope — one budget for the whole
 * run, one tool table, one record the caller reads.
 */
export interface RunScope {
  tools: Map<string, Tool>;
  budget: Budget;
  /** Absent when the run declared none: the conversation then grows unbounded and is never folded down. */
  context?: RunContext;
  report: ReportEvent;
  model: ModelClient;
}

/**
 * Run one conversation's request/response loop — the run's own, or
 * (recursively, through the subagent tool) a delegate's. Resolves to the
 * final text reply, or `undefined` when the run-wide budget ran out before
 * one arrived.
 */
export async function runConversation(
  conversation: Conversation,
  scope: RunScope,
  signal: AbortSignal,
): Promise<string | undefined> {
  const { messages, size } = conversation;
  for (;;) {
    if (reachedThreshold(size, scope.context)) {
      if (!(await fold(conversation, scope, signal))) return undefined;
    }

    // Read before every request rather than after a fold: what a full
    // window forbids is asking the model again, whatever filled it.
    checkRoom(size, scope.context);

    const grant = scope.budget.take();
    if (grant === undefined) return undefined;

    const reply = await scope.model(messages, wireTools(scope), signal);
    const message = reply.message;
    size.used = reply.used;

    if (message.tool_calls && message.tool_calls.length > 0) {
      // Thrifty on the last permitted request: a tool result obtained now
      // could never be reported back, so the conversation ends here.
      if (grant.last) return undefined;
      messages.push(message);
      for (const call of message.tool_calls) {
        const content = await executeToolCall(call, scope, signal);
        messages.push({ role: 'tool', tool_call_id: call.id, content });
      }
      continue;
    }

    // Recorded even though this turn is about to return: a run's session
    // keeps `messages` across turns (SPEC.md §3), so the reply that ends
    // this turn must stay in the history for the next one to carry forward.
    messages.push(message);
    return message.content ?? '';
  }
}

// Every tool of the run, the agent's own included: a table entry is what
// the model is told about and what answers when it calls, and the two
// cannot be allowed to disagree.
function wireTools(scope: RunScope) {
  return [...scope.tools.values()].map((t) => t.def);
}

async function executeToolCall(call: ToolCall, scope: RunScope, signal: AbortSignal): Promise<string> {
  const tool = scope.tools.get(call.function.name);
  if (tool === undefined) {
    return `Error: unknown tool "${call.function.name}"`;
  }
  return tool.invoke(call.function.arguments, signal);
}
