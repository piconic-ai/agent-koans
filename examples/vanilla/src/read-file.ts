// A tool of this assistant's own: read a file from its workspace. What
// belongs here is resolving a path against that directory and reading it;
// what does not is anything that leaves this process — a tool the agent
// runs itself never reaches the tool service (SPEC.md §2).
//
// The one place this example steps off the Web platform, since a workspace
// is a filesystem and the Web platform has no filesystem API. Everything
// else is fetch and crypto.randomUUID, so the rest runs on Node, Deno, and
// Bun alike.
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { parseArgs, type Tool } from './agent/index.js';

/** Make `read_file` runnable, resolved against `workspaceDir`. */
export function createReadFileTool(workspaceDir: string): Tool {
  return {
    def: {
      name: 'read_file',
      description: 'Read a file from the run workspace by its relative path.',
      input_schema: {
        type: 'object',
        properties: { path: { type: 'string' } },
        required: ['path'],
      },
    },
    async invoke(argsJson) {
      const args = parseArgs(argsJson);
      const rel = typeof args?.path === 'string' ? args.path : undefined;
      if (!rel) return `Error: read_file call is missing "path"`;

      const root = path.resolve(workspaceDir);
      const resolved = path.resolve(root, rel);
      if (resolved !== root && !resolved.startsWith(root + path.sep)) {
        return `Error: path "${rel}" escapes the workspace`;
      }
      try {
        return await readFile(resolved, 'utf8');
      } catch (err) {
        return `Error: could not read "${rel}": ${err instanceof Error ? err.message : String(err)}`;
      }
    },
  };
}
