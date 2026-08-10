// The internal `read_file` tool, as a custom Flue hook.
//
// Named "read_file", not "read": Flue reserves sandbox tool names for its
// own file tools (createReadTool() etc.), and this tool has nothing to do
// with a sandbox — it resolves directly against KOAN_WORKSPACE (SPEC.md
// §2), the run's plain workspace directory, never the mock tool server.
import { useTool } from '@flue/runtime';
import fs from 'node:fs/promises';
import path from 'node:path';
import * as v from 'valibot';

/** Mount `read_file`, resolved against `workspaceDir` (reject path escapes). */
export function useReadFileTool(workspaceDir: string): void {
  useTool({
    name: 'read_file',
    description: 'Read a file from the run workspace by its relative path.',
    input: v.object({ path: v.string() }),
    run: async ({ data }) => {
      const root = path.resolve(workspaceDir);
      const resolved = path.resolve(root, data.path);
      if (resolved !== root && !resolved.startsWith(root + path.sep)) {
        throw new Error(`path "${data.path}" escapes the workspace`);
      }
      return await fs.readFile(resolved, 'utf8');
    },
  });
}
