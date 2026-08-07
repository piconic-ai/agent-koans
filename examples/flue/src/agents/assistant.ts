// The agent itself, defined with Flue's hooks API.
// This file is the part that agent-koans verifies.
'use agent';
import { useInitialData, useModel } from '@flue/runtime';
import { useRunTools, type RunToolDef } from '../tools.js';

export interface AssistantData {
  tools: RunToolDef[];
  toolsBaseUrl: string;
}

export function Assistant() {
  useModel('koan/default');
  const data = useInitialData<AssistantData>() ?? { tools: [], toolsBaseUrl: '' };
  useRunTools(data.tools, data.toolsBaseUrl);
  return 'You are a task-solving agent. Complete the task given by the user.';
}
