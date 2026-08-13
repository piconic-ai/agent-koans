// The surface an agent is built on: everything under this directory is
// reached through here, and nothing under it knows which agent it runs.
// What belongs here is that surface; what does not is any decision a
// particular agent makes — its instructions and its tools are its own
// (assistant.ts).
export { createAgent, type AgentDefinition } from './lifecycle.js';
export { parseArgs, type Tool, type ToolDef } from './tools.js';
export type { RunSetup } from './run.js';
