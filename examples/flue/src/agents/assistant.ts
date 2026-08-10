// The agent itself, defined with Flue's hooks API.
// This file is the part that agent-koans verifies.
'use agent';
import { useInitialData, useModel } from '@flue/runtime';
import { useReadFileTool } from '../read-file.js';
import { useRunSubagents, type RunSubagentDef } from '../subagents.js';
import { useRunTools, type RunToolDef } from '../tools.js';

export interface AssistantData {
  tools: RunToolDef[];
  toolsBaseUrl: string;
  subagents: RunSubagentDef[];
  workspaceDir: string;
}

export function Assistant() {
  useModel('koan/default');
  const data = useInitialData<AssistantData>() ?? { tools: [], toolsBaseUrl: '', subagents: [], workspaceDir: '' };
  useRunTools(data.tools, data.toolsBaseUrl);
  useReadFileTool(data.workspaceDir);
  useRunSubagents(data.subagents, data.tools, data.toolsBaseUrl, data.workspaceDir);
  return 'You are a task-solving agent. Complete the task given by the user.';
}
