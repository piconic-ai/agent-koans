// Per-run subagent declarations, as a custom Flue hook.
//
// Subagents arrive per run (POST /runs), so they are not known at build
// time, unlike a hand-authored specialist agent. A delegate's render is
// isolated from the parent — nothing flows in but the shared environment
// and, unless overridden, the parent's model (SPEC.md §6.4) — so each
// delegate's `agent` function re-mounts the run's own tools and read_file
// itself instead of inheriting the caller's.
import { useSubagent } from '@flue/runtime';
import { useReadFileTool } from './read-file.js';
import { useRunTools, type RunToolDef } from './tools.js';

/** A delegate declared by the run (SPEC.md §3.2). */
export interface RunSubagentDef {
  name: string;
  description?: string;
}

/**
 * Mount one `useSubagent()` declaration per run-declared entry. `model` is
 * deliberately left unset on each definition: omitted, it inherits the
 * parent's turn (here, the `koan/default` model the run's own requests
 * use), which is what keeps a delegate's model requests reaching the mock.
 */
export function useRunSubagents(
  subagents: RunSubagentDef[],
  tools: RunToolDef[],
  toolsBaseUrl: string,
  workspaceDir: string,
): void {
  for (const def of subagents) {
    useSubagent({
      name: def.name,
      description: def.description ?? `Delegate for "${def.name}"`,
      agent: () => {
        useRunTools(tools, toolsBaseUrl);
        useReadFileTool(workspaceDir);
        return 'You are a subagent delegated a focused task by another agent. Complete it and reply with your final answer.';
      },
    });
  }
}
