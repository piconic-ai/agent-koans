// The runner's public surface. Everything user-facing is exported and
// documented from here; every module behind it is internal.
export { discoverKoans, loadKoan } from './koan.js';
export type { DiscoveredKoan, Koan, Matcher, ModelTurn, ToolDef, ToolResponse } from './koan.js';
export { runKoan } from './harness.js';
export type { AgentConfig } from './harness.js';
