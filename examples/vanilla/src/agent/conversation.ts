// The loop: ask the model, run what it asked for, ask again. What belongs
// here is the order those steps happen in and what ends them; what does
// not is how any one step is carried out — the model request, a tool, a
// fold, and the budget each keep their own file.
//
// No agent framework anywhere below it. This loop, and the run lifecycle
// that drives it, are the part agent-koans verifies.
import { foldOnThreshold } from './compaction.js';
import type { ChatMessage, ToolCall } from './model.js';
import type { Run } from './run.js';
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
  /**
   * What provisions this conversation's window and threshold — the run's
   * own for the main conversation, a delegate's own declaration for a
   * subagent's, absent for a delegate the run declared none for. Kept
   * here rather than read off `run.context`: a delegate's conversation is
   * not the run's own, and its window may differ from it (SPEC.md §3).
   */
  context?: RunContext;
  /**
   * How many delegation levels below the run's own conversation this one
   * sits at: absent (0) for the run's own, one more than the delegating
   * conversation's for a subagent's (run.ts's `delegate`). What
   * `given.limits.run.delegation_depth` is checked against before this
   * conversation is allowed to delegate again (subagents.ts).
   */
  depth?: number;
  /**
   * Told after every change to the recorded history — a message
   * appended, or a fold's rewrite. A durable agent hooks its store here
   * (SPEC.md §3), a delegate's conversation included: a crash can land
   * mid-delegation just as easily as mid-turn, so a child's record must
   * survive it the same way the run's own does.
   */
  onRecord?: () => void;
}

/**
 * Run one conversation's request/response loop — the run's own, or
 * (recursively, through the subagent tool) a delegate's. Resolves to the
 * final text reply, or `undefined` when the run's budget ran out before
 * one arrived.
 */
export async function runConversation(
  conversation: Conversation,
  run: Run,
  signal: AbortSignal,
): Promise<string | undefined> {
  const { messages, size, context, onRecord, depth } = conversation;
  for (;;) {
    if (reachedThreshold(size, context)) {
      if (!(await foldOnThreshold(conversation, run, signal))) return undefined;
    }

    // Read before every request rather than after a fold: what a full
    // window forbids is asking the model again, whatever filled it.
    checkRoom(size, context);

    const grant = run.budget.take();
    if (grant === undefined) return undefined;

    const reply = await run.model(messages, wireTools(run), signal);
    const message = reply.message;
    size.used = reply.used;

    if (message.tool_calls && message.tool_calls.length > 0) {
      // Thrifty on the last permitted request: a tool result obtained now
      // could never be reported back, so the conversation ends here.
      if (grant.last) return undefined;
      messages.push(message);
      onRecord?.();
      for (const call of message.tool_calls) {
        const content = await executeToolCall(call, run, signal, depth ?? 0);
        messages.push({ role: 'tool', tool_call_id: call.id, content });
        onRecord?.();
      }
      continue;
    }

    // Recorded even though this turn is about to return: a run's session
    // keeps `messages` across turns (SPEC.md §3), so the reply that ends
    // this turn must stay in the history for the next one to carry forward.
    messages.push(message);
    onRecord?.();
    return message.content ?? '';
  }
}

// Every tool of the run, the agent's own included: a table entry is what
// the model is told about and what answers when it calls, and the two
// cannot be allowed to disagree.
function wireTools(run: Run) {
  return [...run.tools.values()].map((t) => t.def);
}

async function executeToolCall(call: ToolCall, run: Run, signal: AbortSignal, depth: number): Promise<string> {
  const tool = run.tools.get(call.function.name);
  if (tool === undefined) {
    return `Error: unknown tool "${call.function.name}"`;
  }
  return tool.invoke(call.function.arguments, signal, call.id, depth);
}
