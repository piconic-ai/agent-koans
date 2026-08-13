// The agent this example is: what it is told it is, and what it can do
// that no caller has to declare. What belongs here is those two choices;
// what does not is anything about how an agent runs — that is the same for
// every agent, and lives under agent/.
//
// This is the whole of the difference between this example and another
// agent built on the same directory.
import type { AgentDefinition } from './agent/index.js';
import type { Config } from './config.js';
import { createReadFileTool } from './read-file.js';

const INSTRUCTIONS = `You are a task-solving assistant. Complete the task the user gives you.
Answer plainly, in as few words as the task allows. When a file is named,
read it rather than guessing what it holds.`;

/** Define the assistant, with the workspace its file tool reads from. */
export function assistant(config: Config): AgentDefinition {
  return {
    system: INSTRUCTIONS,
    tools: [createReadFileTool(config.workspace.dir)],
  };
}
