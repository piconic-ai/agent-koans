// The agent itself, defined with Flue's hooks API.
// This file is the part that agent-koans verifies.
'use agent';
import { useInitialData, useModel } from '@flue/runtime';
import { CONTEXT_WINDOW } from '../provider.js';
import { useReadFileTool } from '../read-file.js';
import { useRunSubagents, type RunSubagentDef } from '../subagents.js';
import { useRunTools, type RunToolDef } from '../tools.js';

/** The run's context window and compaction policy (SPEC.md §3). */
export interface RunContext {
  window: number;
  compaction?: { at_percent: number };
}

export interface AssistantData {
  tools: RunToolDef[];
  toolsBaseUrl: string;
  subagents: RunSubagentDef[];
  workspaceDir: string;
  context?: RunContext;
}

// Not passed through: Flue triggers on headroom left in the model's own
// window (`used > contextWindow - reserveTokens`), so the run's share is
// converted against the registered one. `keepRecentTokens` is 0 because
// the harness's conversations are a few hundred bytes against a six-figure
// declared size — any "recent" history would be all of it.
function compactionOf(context: RunContext | undefined) {
  if (context?.compaction === undefined) return false as const;
  const threshold = Math.ceil((context.window * context.compaction.at_percent) / 100);
  return { reserveTokens: CONTEXT_WINDOW - threshold, keepRecentTokens: 0 };
}

export function Assistant() {
  const data = useInitialData<AssistantData>() ?? { tools: [], toolsBaseUrl: '', subagents: [], workspaceDir: '' };
  useModel('koan/default', { compaction: compactionOf(data.context) });
  useRunTools(data.tools, data.toolsBaseUrl);
  useReadFileTool(data.workspaceDir);
  useRunSubagents(data.subagents, data.tools, data.toolsBaseUrl, data.workspaceDir);
  return 'You are a task-solving agent. Complete the task given by the user.';
}
