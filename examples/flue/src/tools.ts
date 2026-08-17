// Per-run tool definitions, as a custom Flue hook.
//
// Tools arrive per run (POST /runs), so they are not known at build time.
// The koan's JSON Schema is converted to Valibot so Flue itself validates
// arguments and reports failures to the model, without invoking run().
import { useTool } from '@flue/runtime';
import * as v from 'valibot';

export interface RunToolDef {
  name: string;
  description?: string;
  /** How long the caller wants an invocation waited for (SPEC.md §3). */
  timeout_ms?: number;
  input_schema: {
    type?: string;
    properties?: Record<string, { type?: string }>;
    required?: string[];
  };
}

function toValibot(schema: RunToolDef['input_schema']): v.GenericSchema<Record<string, unknown>, unknown> {
  const required = new Set(schema.required ?? []);
  const entries: Record<string, v.GenericSchema<unknown, unknown>> = {};
  for (const [key, prop] of Object.entries(schema.properties ?? {})) {
    const base =
      prop.type === 'string'
        ? v.string()
        : prop.type === 'number'
          ? v.number()
          : prop.type === 'boolean'
            ? v.boolean()
            : v.unknown();
    entries[key] = (required.has(key) ? base : v.optional(base)) as v.GenericSchema<unknown, unknown>;
  }
  // looseObject, not object: a plain object() schema strips any key its
  // entries do not name, which would silently drop an argument the JSON
  // Schema never declared before the tool's run() ever saw it
  // (koans/023-undeclared-argument).
  return v.looseObject(entries) as v.GenericSchema<Record<string, unknown>, unknown>;
}

export function useRunTools(tools: RunToolDef[], toolsBaseUrl: string): void {
  for (const def of tools) {
    useTool({
      name: def.name,
      description: def.description ?? def.name,
      input: toValibot(def.input_schema ?? {}),
      run: async ({ data: args }) => {
        const res = await fetch(`${toolsBaseUrl}/invoke/${encodeURIComponent(def.name)}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(args),
          // The declared wait, exactly (SPEC.md §3): the rejection this
          // raises is a tool failure Flue reports to the model, like the
          // non-ok throw below.
          ...(def.timeout_ms === undefined ? {} : { signal: AbortSignal.timeout(def.timeout_ms) }),
        });
        const body = await res.text();
        if (!res.ok) {
          throw new Error(`tool "${def.name}" failed with status ${res.status}: ${body}`);
        }
        return body;
      },
    });
  }
}
