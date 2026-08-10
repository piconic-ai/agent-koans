// The runner's public surface. Everything user-facing is exported and
// documented from here; every module behind it is internal.
export { discoverKoans, loadKoan } from './koan.js';
export type {
  CallToolInstruction,
  Conversation,
  DelegationInstruction,
  DiscoveredKoan,
  Judgment,
  Koan,
  Matcher,
  ModelTurn,
  RunLimits,
  ToolDef,
  ToolResponse,
  Trace,
  TurnBoundary,
  TurnSpec,
} from './koan.js';
export { runKoan } from './runner.js';
export type { AgentConfig } from './runner.js';
export type { DelegationVocabulary } from './config.js';
