// Tools as this agent runs them: the one shape every tool the model may
// call has, and the run-declared kind that reaches the tool server. What
// belongs here is argument handling and that request; what does not is a
// capability of the agent's own — those are tools too, and each keeps its
// own file (read-file.ts, subagents.ts).

/** A tool the run declared, as it arrived at POST /runs. */
export interface ToolDef {
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

/** A tool the model may call: what the model is told about it, and how this agent runs it. */
export interface Tool {
  def: ToolDef;
  /** Run one call. Resolves to what goes back to the model — failures as text, too. */
  invoke(argsJson: string, signal: AbortSignal): Promise<string>;
}

/** Read a call's arguments; `undefined` when the model did not write a JSON object. */
export function parseArgs(argsJson: string): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = JSON.parse(argsJson || '{}');
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

/** Make a run-declared tool runnable: validated here, executed at the tool server. */
export function createDeclaredTool(def: ToolDef, toolsBaseUrl: string): Tool {
  return {
    def,
    async invoke(argsJson, signal) {
      const args = parseArgs(argsJson);
      if (args === undefined) {
        return `Error: tool arguments are not valid JSON`;
      }

      const validationErrors = validateArgs(args, def.input_schema ?? {});
      if (validationErrors.length > 0) {
        return `Error: invalid arguments for "${def.name}": ${validationErrors.join('; ')}`;
      }

      let res: Response;
      try {
        res = await fetch(`${toolsBaseUrl}/invoke/${encodeURIComponent(def.name)}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          // `args`, not the declared properties of it: an argument the schema
          // never mentioned is still the model's, and dropping it here would
          // rewrite the call before the tool ever saw it.
          body: JSON.stringify(args),
          // The declared wait, exactly (SPEC.md §3): giving up is the
          // timeout signal's, never a shorter one of this agent's own.
          signal:
            def.timeout_ms === undefined ? signal : AbortSignal.any([signal, AbortSignal.timeout(def.timeout_ms)]),
        });
      } catch (err) {
        // Not rethrown: a transport failure is a tool failure like any
        // other, and it is the model's to react to (SPEC.md §4) — thrown,
        // it would end the run instead. An abort is the caller's, though,
        // and must keep unwinding the turn.
        if (signal.aborted) throw err;
        return `Error: tool "${def.name}" request failed: ${err instanceof Error ? err.message : String(err)}`;
      }
      const body = await res.text();
      if (!res.ok) {
        return `Error: tool "${def.name}" failed with status ${res.status}: ${body}`;
      }
      return body;
    },
  };
}

function jsonType(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

function validateArgs(args: Record<string, unknown>, schema: ToolDef['input_schema']): string[] {
  const errors: string[] = [];
  for (const key of schema.required ?? []) {
    if (!(key in args)) errors.push(`missing required property "${key}"`);
  }
  for (const [key, prop] of Object.entries(schema.properties ?? {})) {
    if (key in args && prop.type && jsonType(args[key]) !== prop.type) {
      errors.push(`property "${key}" must be of type ${prop.type}, got ${jsonType(args[key])}`);
    }
  }
  return errors;
}
