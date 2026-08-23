// What a run is made of: the tools it may call, the budget it spends, the
// window it grows into, the model it asks, and the record its caller
// reads — assembled from what the run was submitted with. What belongs
// here is that assembly; what does not is anything about a run's progress,
// which is the agent's to drive (agent.ts).
import { createBudget, type Budget, type RunLimits } from './budget.js';
import type { ReportEvent } from './compaction.js';
import { runConversation, type Conversation } from './conversation.js';
import type { ModelClient } from './model.js';
import { createSubagentTool, type Delegate, type SubagentDef } from './subagents.js';
import { createDeclaredTool, type Tool, type ToolDef } from './tools.js';
import type { RunContext } from './window.js';

// Where the agent process reaches, the same for every run it accepts.
interface AgentParts {
  model: ModelClient;
  toolsBaseUrl: string;
  /** Tools of the agent's own, from its definition (lifecycle.ts). */
  own: Tool[];
}

/** What a run was submitted with, beyond the prompt that opened it (SPEC.md §3). */
export interface RunSetup {
  tools: ToolDef[];
  subagents: SubagentDef[];
  limits?: RunLimits;
  context?: RunContext;
}

/**
 * What every conversation of one run shares. A delegate is given a
 * conversation of its own and this same run — which is why the budget it
 * spends is the run's, and the tools it may call are the run's. Not a
 * window, though: each conversation's own `context` provisions it
 * (conversation.ts), the run's own included, since parent and delegate may
 * run different models with different windows (SPEC.md §3).
 */
export interface Run {
  tools: Map<string, Tool>;
  budget: Budget;
  report: ReportEvent;
  model: ModelClient;
}

/**
 * What a run's caller (lifecycle.ts) needs to know about a delegation's
 * child conversation, for durability (SPEC.md §3): that it exists, from
 * the moment it starts, and that it stops mattering once its delegation
 * closes. Optional throughout — a caller that persists nothing may omit
 * both.
 */
export interface RunHooks {
  /** A child conversation has started; `conv` is the same object `delegate` runs, so its messages keep growing in place. */
  onChildStart?: (callId: string, conv: Conversation) => void;
  /** The delegation this child answered has closed — nothing about the child is worth keeping past this point. */
  onChildEnd?: (callId: string) => void;
}

/** Assemble a run from what it was submitted with. `spent` resumes a prior process's own request count (SPEC.md §3). */
export function createRun(parts: AgentParts, setup: RunSetup, report: ReportEvent, spent = 0, hooks?: RunHooks): Run {
  const tools = new Map<string, Tool>();
  const run: Run = {
    tools,
    budget: createBudget(setup.limits, spent),
    report,
    model: parts.model,
  };
  // Delegation is the loop again: a conversation of its own, because a
  // subagent conversation cannot be continued yet, and a size of its own —
  // but the same run, so what it spends comes out of the run's budget.
  // `context` is the delegate's own declaration, not the run's: absent
  // when the run declared this delegate none, which is what leaves its
  // conversation with no window and no threshold (SPEC.md §3).
  const delegate: Delegate = async (briefing, context, signal, callId, depth) => {
    const conv: Conversation = { messages: [{ role: 'user', content: briefing }], size: { used: 0 }, context, depth };
    hooks?.onChildStart?.(callId, conv);
    try {
      return await runConversation(conv, run, signal);
    } finally {
      hooks?.onChildEnd?.(callId);
    }
  };

  for (const def of setup.tools) register(tools, createDeclaredTool(def, parts.toolsBaseUrl));
  // Registered after the run's own, so a run that declares one of these
  // names cannot reroute a capability of the agent's to the tool server.
  for (const tool of parts.own) register(tools, tool);
  if (setup.subagents.length > 0) {
    register(tools, createSubagentTool(setup.subagents, delegate, setup.limits?.run?.delegation_depth));
  }
  return run;
}

function register(tools: Map<string, Tool>, tool: Tool): void {
  tools.set(tool.def.name, tool);
}
