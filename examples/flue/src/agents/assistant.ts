// The agent itself, defined with Flue's hooks API.
// This file is the part that agent-koans verifies.
//
// Tools arrive per run (POST /runs), so they are not known at build time:
// the server passes them through dispatch initialData, and the agent
// declares one useTool per definition. The koan's JSON Schema is converted
// to Valibot so argument validation (R6) is done by Flue itself, which
// reports failures back to the model without invoking run() (R3). Tool
// server errors are thrown from run(); Flue forwards them to the model
// without retrying (R4).
'use agent';
import { useInitialData, useModel, useTool } from '@flue/runtime';
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

export interface AssistantData {
  tools: RunToolDef[];
  toolsBaseUrl: string;
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

export function Assistant() {
  useModel('koan/default');
  const data = useInitialData<AssistantData>() ?? { tools: [], toolsBaseUrl: '' };

  for (const def of data.tools) {
    useTool({
      name: def.name,
      description: def.description ?? def.name,
      input: toValibot(def.input_schema ?? {}),
      // run() receives an envelope; the validated arguments are in `data`.
      run: async ({ data: args }) => {
        const res = await fetch(`${data.toolsBaseUrl}/invoke/${encodeURIComponent(def.name)}`, {
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

  return 'You are a task-solving agent. Complete the task given by the user.';
}
