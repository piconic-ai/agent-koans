// Per-run tool definitions, as a custom Flue hook.
//
// Tools arrive per run (POST /runs), so they are not known at build time.
// The koan's JSON Schema is converted to Valibot so argument validation
// (R6) is done by Flue itself, which reports failures back to the model
// without invoking run() (R3). Tool server errors are thrown from run();
// Flue forwards them to the model without retrying (R4).
import { useTool } from '@flue/runtime';
import * as v from 'valibot';

export interface RunToolDef {
  name: string;
  description?: string;
  input_schema: {
    type?: string;
    properties?: Record<string, { type?: string }>;
    required?: string[];
  };
}

/** Convert the koan's JSON Schema subset to a Valibot schema. */
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
  return v.object(entries) as v.GenericSchema<Record<string, unknown>, unknown>;
}

/** Declare one tool per run definition, executing against the tool server. */
export function useRunTools(tools: RunToolDef[], toolsBaseUrl: string): void {
  for (const def of tools) {
    useTool({
      name: def.name,
      description: def.description ?? def.name,
      input: toValibot(def.input_schema ?? {}),
      // run() receives an envelope; the validated arguments are in `data`.
      run: async ({ data: args }) => {
        const res = await fetch(`${toolsBaseUrl}/invoke/${encodeURIComponent(def.name)}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(args),
        });
        const body = await res.text();
        if (!res.ok) {
          // R3: report the failure to the model; R4: no retry here.
          throw new Error(`tool "${def.name}" failed with status ${res.status}: ${body}`);
        }
        return body;
      },
    });
  }
}
