// What the koan file format promises. Reads as a specification: the table
// below is the format's rule set, one row per rule, each row the smallest
// koan that breaks it and the exact message src/parse.ts reports for it.
// Runtime behavior (what a passing/failing run looks like) belongs to
// conformance.test.ts and cli.test.ts, not here — this file only checks
// the load-time contract.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';
import { describe, expect, it } from 'vitest';
import { parseKoanFile } from '../src/parse.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

describe('parseKoanFile: bundled koans', () => {
  const dir = path.join(repoRoot, 'koans');
  for (const name of fs.readdirSync(dir).sort()) {
    if (!name.endsWith('.yaml')) continue;
    it(`${name} is a valid koan file`, () => {
      const raw = parseYaml(fs.readFileSync(path.join(dir, name), 'utf8'));
      const result = parseKoanFile(raw);
      expect(typeof result === 'string' ? result : undefined).toBeUndefined();
    });
  }
});

/** One rule of the format: the smallest koan that breaks it, and the exact message it is rejected with. */
interface Row {
  rule: string;
  yaml: string;
  message: string;
}

// Reading top to bottom is reading the format's constraints, roughly in
// the order src/parse.ts checks them: the file itself, `given`, which
// body a koan has, a `when`/`one_of` trace step by step, a model
// response's own shape, an instruction's own shape, and finally the
// constraints — the rules that read the whole parsed file.
const rows: Row[] = [
  { rule: 'the file is a YAML mapping', yaml: `- not\n- a\n- mapping\n`, message: 'not a YAML mapping' },
  { rule: 'the file has a "name"', yaml: `{}\n`, message: 'missing "name"' },
  {
    rule: '"given" is a mapping',
    yaml: `name: x\ngiven: nope\nprompt: p\nwhen:\n  - request: model\n    response: ok\n`,
    message: '"given" must be a mapping',
  },
  {
    rule: '"given.task" was replaced by a top-level "prompt"',
    yaml: `name: x\ngiven:\n  task: do it\nprompt: p\nwhen:\n  - request: model\n    response: ok\n`,
    message: '"given.task" was replaced by a top-level "prompt" field',
  },
  {
    rule: '"given.tools" is a mapping of tool name to definition',
    yaml: `name: x\ngiven:\n  tools: nope\nprompt: p\nwhen:\n  - request: model\n    response: ok\n`,
    message: '"given.tools" must be a mapping of tool name to definition',
  },
  {
    rule: '"given.files" is a mapping of path to content',
    yaml: `name: x\ngiven:\n  files: nope\nprompt: p\nwhen:\n  - request: model\n    response: ok\n`,
    message: '"given.files" must be a mapping of relative path to file content',
  },
  {
    rule: 'each given.files entry is a string',
    yaml: `name: x\ngiven:\n  files:\n    a.txt: [1, 2]\nprompt: p\nwhen:\n  - request: model\n    response: ok\n`,
    message: `given.files["a.txt"] must be a string (the file's content)`,
  },
  {
    rule: 'a given.files path stays inside the workspace',
    yaml: `name: x\ngiven:\n  files:\n    "../escape.txt": "x"\nprompt: p\nwhen:\n  - request: model\n    response: ok\n`,
    message: `given.files["../escape.txt"] must be a relative path inside the workspace (no leading "/", no "..")`,
  },
  {
    rule: '"given.limits" is a mapping',
    yaml: `name: x\ngiven:\n  limits: nope\nprompt: p\nwhen:\n  - request: model\n    response: ok\n`,
    message: '"given.limits" must be a mapping',
  },
  {
    rule: '"given.limits" has no unknown key',
    yaml: `name: x\ngiven:\n  limits:\n    max_model_requests: 3\n    extra: 1\nprompt: p\nwhen:\n  - request: model\n    response: ok\n`,
    message: '"given.limits" has unknown key "extra"',
  },
  {
    rule: '"given.limits.max_model_requests" is a positive integer',
    yaml: `name: x\ngiven:\n  limits: {}\nprompt: p\nwhen:\n  - request: model\n    response: ok\n`,
    message: '"given.limits.max_model_requests" must be a positive integer',
  },
  {
    rule: '"prompt" cannot combine with "turns"',
    yaml: `name: x\nprompt: p\nturns:\n  - prompt: a\n    when: [{ request: model, response: ok }]\n  - prompt: b\n    when: [{ request: model, response: ok }]\n`,
    message: `"prompt" cannot be combined with "turns" — the first turn's prompt is the initial one`,
  },
  {
    rule: '"turns" cannot combine with "when" or "one_of"',
    yaml: `name: x\nwhen:\n  - request: model\n    response: ok\nturns:\n  - prompt: a\n    when: [{ request: model, response: ok }]\n  - prompt: b\n    when: [{ request: model, response: ok }]\n`,
    message: '"turns" cannot be combined with "when" or "one_of"',
  },
  {
    rule: '"then" cannot combine with "turns"',
    yaml: `name: x\nturns:\n  - prompt: a\n    when: [{ request: model, response: ok }]\n  - prompt: b\n    when: [{ request: model, response: ok }]\nthen:\n  status: completed\n`,
    message: '"then" cannot be combined with "turns" — write it on the last turn instead',
  },
  {
    rule: 'a koan needs exactly one of "when" / "one_of" / "turns"',
    yaml: `name: x\nprompt: p\nwhen:\n  - request: model\n    response: ok\none_of:\n  a: [{ request: model, response: ok }]\n  b: [{ request: model, response: no }]\n`,
    message: 'a koan needs exactly one of "when" / "one_of" / "turns"',
  },
  {
    rule: 'a "when"/"one_of" koan needs a "prompt"',
    yaml: `name: x\nwhen:\n  - request: model\n    response: ok\n`,
    message: 'missing "prompt"',
  },
  {
    rule: '"prompt" is non-empty',
    yaml: `name: x\nprompt: "   "\nwhen:\n  - request: model\n    response: ok\n`,
    message: '"prompt" must be non-empty',
  },
  {
    rule: '"then" is a mapping',
    yaml: `name: x\nprompt: p\nwhen:\n  - request: model\n    response: ok\nthen: nope\n`,
    message: 'then must be a mapping',
  },
  {
    rule: '"then" has no unknown key',
    yaml: `name: x\nprompt: p\nwhen:\n  - request: model\n    response: ok\nthen:\n  status: completed\n  extra: 1\n`,
    message: 'then has unknown key "extra" — a judgment carries only "status" and "output"',
  },
  {
    rule: '"then.status" is a string',
    yaml: `name: x\nprompt: p\nwhen:\n  - request: model\n    response: ok\nthen:\n  status: 1\n`,
    message: 'then.status must be a string',
  },
  {
    rule: '"when" is a non-empty list',
    yaml: `name: x\nprompt: p\nwhen: []\n`,
    message: '"when" must be a non-empty list of trace steps',
  },
  {
    rule: '"one_of" is a mapping of variant name to trace',
    yaml: `name: x\nprompt: p\none_of: nope\n`,
    message: '"one_of" must be a mapping of variant name to trace',
  },
  {
    rule: '"one_of" needs at least two variants',
    yaml: `name: x\nprompt: p\none_of:\n  a: [{ request: model, response: ok }]\n`,
    message: '"one_of" needs at least two variants — use "when" for a single trace',
  },
  {
    rule: 'each "one_of" variant is a non-empty list',
    yaml: `name: x\nprompt: p\none_of:\n  a: []\n  b: [{ request: model, response: ok }]\n`,
    message: '"one_of.a" must be a non-empty list of trace steps',
  },
  {
    rule: '"turns" is a non-empty list',
    yaml: `name: x\nturns: []\n`,
    message: '"turns" must be a non-empty list of turn entries',
  },
  {
    rule: '"turns" needs at least two entries',
    yaml: `name: x\nturns:\n  - prompt: a\n    when: [{ request: model, response: ok }]\n`,
    message: '"turns" needs at least two entries — a 1-turn koan is just "when"',
  },
  {
    rule: 'each turn needs a non-empty "prompt"',
    yaml: `name: x\nturns:\n  - prompt: "  "\n    when: [{ request: model, response: ok }]\n  - prompt: b\n    when: [{ request: model, response: ok }]\n`,
    message: 'turns[0] needs a non-empty "prompt"',
  },
  {
    rule: 'a turn entry has no unknown key',
    yaml: `name: x\nturns:\n  - prompt: a\n    when: [{ request: model, response: ok }]\n    extra: 1\n  - prompt: b\n    when: [{ request: model, response: ok }]\n`,
    message: 'turns[0] has unknown key "extra" — a turn entry carries only "prompt", "when", and "then"',
  },
  {
    rule: 'a turn\'s "when" is a non-empty list',
    yaml: `name: x\nturns:\n  - prompt: a\n    when: []\n  - prompt: b\n    when: [{ request: model, response: ok }]\n`,
    message: 'turns[0].when must be a non-empty list of trace steps',
  },
  {
    rule: 'a non-final turn ends with a plain text reply',
    yaml: `name: x\nturns:\n  - prompt: a\n    when:\n      - request: model\n        response: { tool: x, args: {} }\n  - prompt: b\n    when: [{ request: model, response: ok }]\n`,
    message: `turns[0].when must end with a plain text reply — an intermediate turn can only be judged "completed" by ending in one (SPEC.md §6.5)`,
  },
  {
    rule: 'every delegation is answered by a "subagent" block',
    yaml: `name: x\nprompt: p\nwhen:\n  - request: model\n    response: { subagent: r, prompt: "go look" }\n`,
    message: `when[1]: delegation to "r" has no following "subagent" block — every delegation's conversation must be scripted`,
  },
  {
    rule: 'a nested trace (a subagent block\'s "when") is a non-empty list',
    yaml: `name: x\nprompt: p\nwhen:\n  - request: model\n    response: { subagent: r, prompt: "go look" }\n  - subagent: r\n    when: []\n`,
    message: 'when[1].when must be a non-empty list of trace steps',
  },
  {
    rule: 'nothing follows a model API failure',
    yaml: `name: x\nprompt: p\nwhen:\n  - request: model\n    response: { status: 401 }\n  - request: model\n    response: "too late"\n`,
    message: 'when[1]: nothing can follow a model API failure — the agent must stop (R8)',
  },
  {
    rule: 'nothing follows "abort"',
    yaml: `name: x\nprompt: p\nwhen:\n  - request: model\n    response: ok\n  - abort\n  - request: model\n    response: again\n`,
    message: `when[2]: nothing can follow "abort" — it must be the trace's last step`,
  },
  {
    rule: '"abort" cannot appear inside a "turns" koan',
    yaml: `name: x\nturns:\n  - prompt: a\n    when:\n      - request: model\n        response: ok\n      - abort\n  - prompt: b\n    when: [{ request: model, response: ok }]\n`,
    message: `turns[0].when[1]: "abort" cannot appear inside a "turns" koan — turn-level cancellation is not supported yet`,
  },
  {
    rule: '"abort" cannot appear inside a subagent block',
    yaml: `name: x\nprompt: p\nwhen:\n  - request: model\n    response: { subagent: r, prompt: "go look" }\n  - subagent: r\n    when:\n      - request: model\n        response: ok\n      - abort\n`,
    message: `when[1].when[1]: "abort" cannot appear inside a subagent block — only the caller's own run can be aborted`,
  },
  {
    rule: '"abort" needs at least one exchange before it',
    yaml: `name: x\nprompt: p\nwhen:\n  - abort\n`,
    message: 'when[0]: "abort" needs at least one exchange before it in the trace',
  },
  {
    rule: 'a subagent block has no unknown key',
    yaml: `name: x\nprompt: p\nwhen:\n  - request: model\n    response: { subagent: r, prompt: "go look" }\n  - subagent: r\n    when: [{ request: model, response: ok }]\n    extra: 1\n`,
    message: 'when[1] has unknown key "extra" — a subagent block carries only "subagent" and "when"',
  },
  {
    rule: 'a subagent block names a non-empty delegate',
    yaml: `name: x\nprompt: p\nwhen:\n  - request: model\n    response: { subagent: r, prompt: "go look" }\n  - subagent: ""\n    when: [{ request: model, response: ok }]\n`,
    message: 'when[1].subagent must be a non-empty delegate name',
  },
  {
    rule: 'a subagent block matches a pending delegation',
    yaml: `name: x\nprompt: p\nwhen:\n  - request: model\n    response: ok\n  - subagent: ghost\n    when: [{ request: model, response: hi }]\n`,
    message: `when[1]: subagent block "ghost" has no matching pending delegation — the preceding model response must include { subagent: "ghost", prompt: ... }`,
  },
  {
    rule: "a subagent block ends with the child's final text reply",
    yaml: `name: x\nprompt: p\nwhen:\n  - request: model\n    response: { subagent: r, prompt: "go look" }\n  - subagent: r\n    when:\n      - request: model\n        response: { tool: x, args: {} }\n`,
    message: `when[1]: a subagent block must end with the child's final text reply — it is what returns to the parent`,
  },
  {
    rule: 'a trace entry needs "request"',
    yaml: `name: x\nprompt: p\nwhen:\n  - response: ok\n`,
    message: 'when[0] needs "request"',
  },
  {
    rule: 'a trace entry needs "response"',
    yaml: `name: x\nprompt: p\nwhen:\n  - request: model\n`,
    message: 'when[0] needs "response"',
  },
  {
    rule: 'a model request cannot follow a text reply',
    yaml: `name: x\nprompt: p\nwhen:\n  - request: model\n    response: done\n  - request: model\n    response: again\n`,
    message: `when[1]: a model request cannot follow a text reply here — only a later turn's first request may (SPEC.md §6.5)`,
  },
  {
    rule: 'a tool request needs a numeric "status"',
    yaml: `name: x\nprompt: p\nwhen:\n  - request: model\n    response: { tool: x, args: {} }\n  - request: { tool: x }\n    response: "nope"\n`,
    message: 'when[1].response needs a numeric "status" for a tool request',
  },
  {
    rule: 'a tool request must follow a model response with a tool-call instruction',
    yaml: `name: x\nprompt: p\nwhen:\n  - request: model\n    response: done\n  - request: { tool: x }\n    response: { status: 200 }\n`,
    message: 'when[1]: a tool request must follow a model response containing a tool-call instruction',
  },
  {
    rule: 'a tool request cannot close an already-closed call',
    yaml: `name: x\nprompt: p\nwhen:\n  - request: model\n    response: { tool: x, args: {} }\n  - request: { tool: x }\n    response: { status: 200 }\n  - request: { tool: x }\n    response: { status: 200 }\n`,
    message: 'when[2]: the preceding tool-call instruction for "x" already has a tool request',
  },
  {
    rule: 'a tool request names a tool the model actually requested',
    yaml: `name: x\nprompt: p\nwhen:\n  - request: model\n    response: { tool: x, args: {} }\n  - request: { tool: y }\n    response: { status: 200 }\n`,
    message: 'when[1].request.tool is "y" but the preceding model response requests "x"',
  },
  {
    rule: 'a repeated tool name in a group needs "args" to pick a call',
    yaml: `name: x\nprompt: p\nwhen:\n  - request: model\n    response:\n      - { tool: x, args: { a: 1 } }\n      - { tool: x, args: { a: 2 } }\n  - request: { tool: x }\n    response: { status: 200 }\n`,
    message: 'when[1]: "x" appears more than once in the preceding group — write "args" to say which call this closes',
  },
  {
    rule: '"args" must match exactly one pending call',
    yaml: `name: x\nprompt: p\nwhen:\n  - request: model\n    response:\n      - { tool: x, args: { a: 1 } }\n      - { tool: x, args: { a: 2 } }\n  - request: { tool: x, args: { a: 3 } }\n    response: { status: 200 }\n`,
    message: 'when[1]: "args" does not match exactly one of the pending "x" calls in the group',
  },
  {
    rule: 'malformed args forbid a following tool request',
    yaml: `name: x\nprompt: p\nwhen:\n  - request: model\n    response: { tool: x, args: "{not json" }\n  - request: { tool: x }\n    response: { status: 200 }\n`,
    message: `when[1]: "x"'s arguments do not parse as a JSON object — argument fidelity is undefined, so the agent must refuse the call instead (R6); no tool request can follow it`,
  },
  {
    rule: 'a trace entry\'s "request" is "model" or { tool }',
    yaml: `name: x\nprompt: p\nwhen:\n  - request: nonsense\n    response: ok\n`,
    message: 'when[0].request must be "model" or { tool: <name> }',
  },
  {
    rule: 'a parallel group needs at least two instructions',
    yaml: `name: x\nprompt: p\nwhen:\n  - request: model\n    response:\n      - { tool: x, args: {} }\n`,
    message: `when[0].response is a list of 1 — a parallel group needs at least two instructions; write the single "{ tool, args }" form instead`,
  },
  {
    rule: 'duplicate members in a parallel group are ambiguous',
    yaml: `name: x\nprompt: p\nwhen:\n  - request: model\n    response:\n      - { tool: x, args: { a: 1 } }\n      - { tool: x, args: { a: 1 } }\n`,
    message: `when[0]: list members [0] and [1] both call "x" with the same arguments — matching a following tool request against them would be ambiguous`,
  },
  {
    rule: 'a subagent name is delegated to at most once per group',
    yaml: `name: x\nprompt: p\nwhen:\n  - request: model\n    response:\n      - { subagent: r, prompt: "go a" }\n      - { subagent: r, prompt: "go b" }\n`,
    message: 'when[0]: two delegations to "r" in one turn — a subagent name may be delegated to at most once per trace',
  },
  {
    rule: 'a delegation response does not mix in other forms',
    yaml: `name: x\nprompt: p\nwhen:\n  - request: model\n    response: { subagent: r, prompt: "go", status: 200 }\n`,
    message: 'when[0].response mixes a delegation instruction with other response forms',
  },
  {
    rule: 'a tool-call response does not mix in "status"',
    yaml: `name: x\nprompt: p\nwhen:\n  - request: model\n    response: { tool: x, args: {}, status: 200 }\n`,
    message: 'when[0].response mixes a tool-call instruction with "status"',
  },
  {
    rule: 'a model API failure cannot appear inside a subagent block',
    yaml: `name: x\nprompt: p\nwhen:\n  - request: model\n    response: { subagent: r, prompt: "go look" }\n  - subagent: r\n    when:\n      - request: model\n        response: { status: 401 }\n`,
    message: 'when[1].when[0]: a model API failure cannot appear inside a subagent block — it ends the whole run (R8)',
  },
  {
    rule: "a model API failure's status is a non-retryable 4xx",
    yaml: `name: x\nprompt: p\nwhen:\n  - request: model\n    response: { status: 429 }\n`,
    message: 'when[0].response.status must be a non-retryable 4xx (not 408/429) for a model API failure',
  },
  {
    rule: 'a model response is a reply, instruction, group, or failure',
    yaml: `name: x\nprompt: p\nwhen:\n  - request: model\n    response: 42\n`,
    message: `when[0].response for a model request must be a reply string, { tool, args }, { subagent, prompt }, a list of instructions, or { status }`,
  },
  {
    rule: 'a tool-call instruction needs "tool"',
    yaml: `name: x\nprompt: p\nwhen:\n  - request: model\n    response:\n      - { args: {} }\n      - { tool: y, args: {} }\n`,
    message: 'when[0][0] needs "tool"',
  },
  {
    rule: 'a tool-call instruction has no unknown key',
    yaml: `name: x\nprompt: p\nwhen:\n  - request: model\n    response: { tool: x, args: {}, extra: 1 }\n`,
    message: 'when[0] has unknown key "extra" — a tool-call instruction carries only "tool" and "args"',
  },
  {
    rule: '"args" is a mapping or a wire string',
    yaml: `name: x\nprompt: p\nwhen:\n  - request: model\n    response: { tool: x, args: 42 }\n`,
    message: 'when[0].args must be a mapping (JSON-encoding sugar) or a string (the verbatim wire arguments)',
  },
  {
    rule: 'a delegation names a non-empty "subagent"',
    yaml: `name: x\nprompt: p\nwhen:\n  - request: model\n    response: { subagent: "" }\n`,
    message: `when[0] needs a non-empty "subagent" (the delegate's name)`,
  },
  {
    rule: 'a delegation instruction has no unknown key',
    yaml: `name: x\nprompt: p\nwhen:\n  - request: model\n    response: { subagent: r, prompt: "go", extra: 1 }\n`,
    message: 'when[0] has unknown key "extra" — a delegation instruction carries only "subagent" and "prompt"',
  },
  {
    rule: 'a delegation needs a non-empty "prompt"',
    yaml: `name: x\nprompt: p\nwhen:\n  - request: model\n    response: { subagent: r, prompt: "   " }\n`,
    message: `when[0] needs a non-empty "prompt" (the briefing)`,
  },
  {
    rule: 'a subagent name is delegated to at most once per trace',
    yaml: `name: x\nprompt: "Do two things."\nwhen:\n  - request: model\n    response: { subagent: r, prompt: "First." }\n  - subagent: r\n    when: [{ request: model, response: "first done" }]\n  - request: model\n    response: { subagent: r, prompt: "Second." }\n  - subagent: r\n    when: [{ request: model, response: "second done" }]\n  - request: model\n    response: ok\n`,
    message: 'when[3]: subagent "r" already has a conversation in this trace — a subagent conversation cannot be continued yet',
  },
  {
    rule: 'openings (the prompt, every briefing) must be mutually distinct',
    yaml: `name: x\nprompt: "Look things up."\nwhen:\n  - request: model\n    response: { subagent: r, prompt: "Look things up." }\n  - subagent: r\n    when: [{ request: model, response: done }]\n  - request: model\n    response: ok\n`,
    message: `when: prompt and the briefing of subagent "r" are not distinct — no briefing may equal or contain another briefing or the prompt, since requests are attributed to conversations by their opening`,
  },
  {
    rule: 'a trace fits the model-request budget',
    yaml: `name: x\ngiven:\n  limits:\n    max_model_requests: 1\nprompt: p\nwhen:\n  - request: model\n    response: { tool: x, args: {} }\n  - request: { tool: x }\n    response: { status: 200 }\n  - request: model\n    response: done\n`,
    message: 'when scripts 2 model requests, more than given.limits.max_model_requests (1) permits',
  },
];

it.each(rows)('rejects: $rule', ({ yaml, message }) => {
  const result = parseKoanFile(parseYaml(yaml));
  expect(result).toBe(message);
});
