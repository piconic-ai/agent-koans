// What a run is made of: the tools it may call, the budget it spends, the
// window it grows into, the model it asks, and the record its caller
// reads — assembled from what the run was submitted with. What belongs
// here is that assembly; what does not is anything about a run's progress,
// which is the agent's to drive (agent.ts).
import { createBudget, type Budget, type RunLimits } from './budget.js';
import type { ReportEvent } from './compaction.js';
import { runConversation } from './conversation.js';
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
 * spends is the run's, and the tools it may call are the run's.
 */
export interface Run {
  tools: Map<string, Tool>;
  budget: Budget;
  /** Absent when the run declared none: its conversations then grow unbounded and are never folded down. */
  context?: RunContext;
  report: ReportEvent;
  model: ModelClient;
}

/** Assemble a run from what it was submitted with. */
export function createRun(parts: AgentParts, setup: RunSetup, report: ReportEvent): Run {
  const tools = new Map<string, Tool>();
  const run: Run = {
    tools,
    budget: createBudget(setup.limits),
    context: setup.context,
    report,
    model: parts.model,
  };
  // Delegation is the loop again: a conversation of its own, because a
  // subagent conversation cannot be continued yet, and a size of its own —
  // but the same run, so what it spends comes out of the run's budget.
  const delegate: Delegate = (briefing, signal) =>
    runConversation({ messages: [{ role: 'user', content: briefing }], size: { used: 0 } }, run, signal);

  for (const def of setup.tools) register(tools, createDeclaredTool(def, parts.toolsBaseUrl));
  // Registered after the run's own, so a run that declares one of these
  // names cannot reroute a capability of the agent's to the tool server.
  for (const tool of parts.own) register(tools, tool);
  if (setup.subagents.length > 0) register(tools, createSubagentTool(setup.subagents, delegate));
  return run;
}

function register(tools: Map<string, Tool>, tool: Tool): void {
  tools.set(tool.def.name, tool);
}
