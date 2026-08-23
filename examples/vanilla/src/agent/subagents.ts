// Delegation, offered to the model as a tool. What belongs here is the
// tool's vocabulary and the check that the model named a delegate the run
// declared; what does not is how a delegate's conversation runs — that is
// the loop again, reached through the `delegate` this file is handed.
import { parseArgs, type Tool } from './tools.js';
import type { RunContext } from './window.js';

/**
 * A delegate declared by the run (SPEC.md §3). `context` provisions this
 * delegate's own conversation the way a run's `context` provisions its
 * own; absent, the delegate has no window and no threshold.
 */
export interface SubagentDef {
  name: string;
  description?: string;
  context?: RunContext;
}

/**
 * Run a briefing as a conversation of its own; `undefined` when the budget
 * ran out first. `context` is the matched `SubagentDef`'s own — absent for
 * a delegate the run declared none for, which is what leaves that
 * conversation's window and threshold both unset. `callId` is the wire
 * `tool_call_id` of the delegation instruction, threaded through so the
 * child conversation it starts can be found again after a crash. `depth`
 * is the child conversation's own — one more than the delegating
 * conversation's (SPEC.md §3) — set on it so a delegation of its own can
 * be checked against the cap in turn.
 */
export type Delegate = (
  prompt: string,
  context: RunContext | undefined,
  signal: AbortSignal,
  callId: string,
  depth: number,
) => Promise<string | undefined>;

/**
 * The delegation tool's own name — the runner's neutral default
 * (agent-koans' `DEFAULT_DELEGATION`), written here rather than read from
 * anywhere since this example declares no vocabulary of its own. Exported
 * so lifecycle.ts's crash recovery can recognize an unclosed call as a
 * delegation without repeating the string.
 */
export const SUBAGENT_TOOL_NAME = 'subagent';

/**
 * Make delegation runnable, over the delegates the run declared. `cap` is
 * `given.limits.run.delegation_depth` (SPEC.md §3) — absent, delegation
 * nests as deep as the model keeps asking for it.
 */
export function createSubagentTool(subagents: SubagentDef[], delegate: Delegate, cap?: number): Tool {
  return {
    def: {
      name: SUBAGENT_TOOL_NAME,
      description:
        'Delegate a focused task to a named subagent. Available: ' +
        subagents.map((s) => (s.description ? `${s.name} (${s.description})` : s.name)).join(', '),
      input_schema: {
        type: 'object',
        properties: { name: { type: 'string' }, prompt: { type: 'string' } },
        required: ['name', 'prompt'],
      },
    },
    async invoke(argsJson, signal, callId, depth) {
      const args = parseArgs(argsJson);
      const name = typeof args?.name === 'string' ? args.name : undefined;
      const prompt = typeof args?.prompt === 'string' ? args.prompt : undefined;
      const def = subagents.find((s) => s.name === name);
      if (!name || !def) {
        return `Error: unknown subagent "${String(name)}"`;
      }
      if (prompt === undefined) {
        return `Error: subagent "${name}" call is missing "prompt"`;
      }
      // Crossed, not spent (SPEC.md §3, Budgets): refused here rather than
      // even reaching `delegate`, the same way an unknown name never does —
      // no child conversation opens for it.
      if (cap !== undefined && depth >= cap) {
        return `Error: cannot delegate to "${name}" — this conversation is already at the run's declared delegation_depth (${cap})`;
      }

      // The briefing, and nothing else: what the parent knows is the
      // parent's, and what the parent gets back is this one answer.
      let text: string | undefined;
      try {
        text = await delegate(prompt, def.context, signal, callId, depth + 1);
      } catch (err) {
        // Not rethrown: losing the model ends the child's conversation,
        // not the run — the parent's model decides what a failed
        // delegation means (SPEC.md §3). An abort is the caller's, though,
        // and settles the run itself.
        if (signal.aborted) throw err;
        return `Error: subagent "${name}" failed: ${err instanceof Error ? err.message : String(err)}`;
      }
      return text ?? `Error: subagent "${name}" did not finish before the model-request budget ran out`;
    },
  };
}
