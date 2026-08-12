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
import { isProblem, parseKoanFile } from '../src/parse.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

describe('parseKoanFile: bundled koans', () => {
  const dir = path.join(repoRoot, 'koans');
  for (const name of fs.readdirSync(dir).sort()) {
    if (!name.endsWith('.yaml')) continue;
    it(`${name} is a valid koan file`, () => {
      const raw = parseYaml(fs.readFileSync(path.join(dir, name), 'utf8'));
      const result = parseKoanFile(raw);
      expect(isProblem(result) ? result.message : undefined).toBeUndefined();
    });
  }
});

/** One rule of the format: the smallest koan that breaks it, and the exact message it is rejected with. */
interface Row {
  rule: string;
  yaml: string;
  message: string;
}

// YAML is whitespace-significant, so a row's fixture is written the way a
// koan author would write it — real newlines, real indentation — and
// dedented at test time, not packed onto one escaped-newline line. The
// envelope helpers below supply the boilerplate every row would otherwise
// repeat (`name:`, a valid `prompt:`, a second valid `turns:` entry), so a
// row shows only what makes it distinctive.

/** Strips a template's leading blank line and its common indentation, keeping one trailing newline. */
function dedent(text: string): string {
  const lines = text.replace(/^\n/, '').split('\n');
  const width = Math.min(...lines.filter((l) => l.trim() !== '').map((l) => l.length - l.trimStart().length));
  return (
    lines
      .map((l) => (l.trim() === '' ? '' : l.slice(width)))
      .join('\n')
      .trimEnd() + '\n'
  );
}

/** Indents every non-blank line of an already-dedented block. */
function indent(text: string, spaces: number): string {
  const pad = ' '.repeat(spaces);
  return text
    .split('\n')
    .map((l) => (l === '' ? '' : pad + l))
    .join('\n');
}

/** A koan with just a `name` — for rows testing the shape of `prompt` or `turns` themselves. */
function bareKoan(body: string): string {
  return `name: x\n${dedent(body)}`;
}

/** A koan with a valid `name`/`prompt` — for rows that are not testing either. */
function koan(body: string): string {
  return `name: x\nprompt: p\n${dedent(body)}`;
}

/** A second, valid turn — the filler every "one broken turn" row needs, since `turns` needs at least two. */
const validTurn = indent(
  dedent(`
    - prompt: b
      when:
        - request: model
          response: ok
  `),
  2,
);

/** A `turns:` koan whose first turn is the row's own (possibly broken) one, followed by `validTurn`. */
function turnsKoan(firstTurn: string): string {
  return `name: x\nturns:\n${indent(dedent(firstTurn), 2)}${validTurn}`;
}

// Reading top to bottom is reading the format's constraints, roughly in
// the order src/parse.ts checks them: the file itself, `given`, which
// body a koan has, a `when`/`one_of` trace step by step, a model
// response's own shape, an instruction's own shape, and finally the
// constraints — the rules that read the whole parsed file.
const rows: Row[] = [
  {
    rule: 'the file is a YAML mapping',
    yaml: dedent(`
      - not
      - a
      - mapping
    `),
    message: 'not a YAML mapping',
  },
  { rule: 'the file has a "name"', yaml: '{}\n', message: 'missing "name"' },
  {
    rule: '"given" is a mapping',
    yaml: koan(`
      given: nope
      when:
        - request: model
          response: ok
    `),
    message: '"given" must be a mapping',
  },
  {
    rule: '"given.task" was replaced by a top-level "prompt"',
    yaml: koan(`
      given:
        task: do it
      when:
        - request: model
          response: ok
    `),
    message: '"given.task" was replaced by a top-level "prompt" field',
  },
  {
    rule: '"given.tools" is a mapping of tool name to definition',
    yaml: koan(`
      given:
        tools: nope
      when:
        - request: model
          response: ok
    `),
    message: '"given.tools" must be a mapping of tool name to definition',
  },
  {
    rule: '"given.files" is a mapping of path to content',
    yaml: koan(`
      given:
        files: nope
      when:
        - request: model
          response: ok
    `),
    message: '"given.files" must be a mapping of relative path to file content',
  },
  {
    rule: 'each given.files entry is a string',
    yaml: koan(`
      given:
        files:
          a.txt: [1, 2]
      when:
        - request: model
          response: ok
    `),
    message: `given.files["a.txt"] must be a string (the file's content)`,
  },
  {
    rule: 'a given.files path stays inside the workspace',
    yaml: koan(`
      given:
        files:
          "../escape.txt": "x"
      when:
        - request: model
          response: ok
    `),
    message: `given.files["../escape.txt"] must be a relative path inside the workspace (no leading "/", no "..")`,
  },
  {
    rule: '"given.limits" is a mapping',
    yaml: koan(`
      given:
        limits: nope
      when:
        - request: model
          response: ok
    `),
    message: '"given.limits" must be a mapping',
  },
  {
    rule: '"given.limits" has no unknown key',
    yaml: koan(`
      given:
        limits:
          max_model_requests: 3
          extra: 1
      when:
        - request: model
          response: ok
    `),
    message: '"given.limits" has unknown key "extra"',
  },
  {
    rule: '"given.limits.max_model_requests" is a positive integer',
    yaml: koan(`
      given:
        limits: {}
      when:
        - request: model
          response: ok
    `),
    message: '"given.limits.max_model_requests" must be a positive integer',
  },
  {
    rule: '"prompt" cannot combine with "turns"',
    yaml: bareKoan(`
      prompt: p
      turns:
        - prompt: a
          when:
            - request: model
              response: ok
        - prompt: b
          when:
            - request: model
              response: ok
    `),
    message: `"prompt" cannot be combined with "turns" — the first turn's prompt is the initial one`,
  },
  {
    rule: '"turns" cannot combine with "when" or "one_of"',
    yaml: bareKoan(`
      when:
        - request: model
          response: ok
      turns:
        - prompt: a
          when:
            - request: model
              response: ok
        - prompt: b
          when:
            - request: model
              response: ok
    `),
    message: '"turns" cannot be combined with "when" or "one_of"',
  },
  {
    rule: '"then" cannot combine with "turns"',
    yaml: bareKoan(`
      turns:
        - prompt: a
          when:
            - request: model
              response: ok
        - prompt: b
          when:
            - request: model
              response: ok
      then:
        status: completed
    `),
    message: '"then" cannot be combined with "turns" — write it on the last turn instead',
  },
  {
    rule: 'a koan needs exactly one of "when" / "one_of" / "turns"',
    yaml: koan(`
      when:
        - request: model
          response: ok
      one_of:
        a:
          - request: model
            response: ok
        b:
          - request: model
            response: no
    `),
    message: 'a koan needs exactly one of "when" / "one_of" / "turns"',
  },
  {
    rule: 'a "when"/"one_of" koan needs a "prompt"',
    yaml: bareKoan(`
      when:
        - request: model
          response: ok
    `),
    message: 'missing "prompt"',
  },
  {
    rule: '"prompt" is non-empty',
    yaml: bareKoan(`
      prompt: "   "
      when:
        - request: model
          response: ok
    `),
    message: '"prompt" must be non-empty',
  },
  {
    rule: '"then" is a mapping',
    yaml: koan(`
      when:
        - request: model
          response: ok
      then: nope
    `),
    message: 'then must be a mapping',
  },
  {
    rule: '"then" has no unknown key',
    yaml: koan(`
      when:
        - request: model
          response: ok
      then:
        status: completed
        extra: 1
    `),
    message: 'then has unknown key "extra" — a judgment carries only "status" and "output"',
  },
  {
    rule: '"then.status" is a string',
    yaml: koan(`
      when:
        - request: model
          response: ok
      then:
        status: 1
    `),
    message: 'then.status must be a string',
  },
  {
    rule: '"when" is a non-empty list',
    yaml: koan(`
      when: []
    `),
    message: '"when" must be a non-empty list of trace steps',
  },
  {
    rule: '"one_of" is a mapping of variant name to trace',
    yaml: koan(`
      one_of: nope
    `),
    message: '"one_of" must be a mapping of variant name to trace',
  },
  {
    rule: '"one_of" needs at least two variants',
    yaml: koan(`
      one_of:
        a:
          - request: model
            response: ok
    `),
    message: '"one_of" needs at least two variants — use "when" for a single trace',
  },
  {
    rule: 'each "one_of" variant is a non-empty list',
    yaml: koan(`
      one_of:
        a: []
        b:
          - request: model
            response: ok
    `),
    message: '"one_of.a" must be a non-empty list of trace steps',
  },
  {
    rule: '"turns" is a non-empty list',
    yaml: bareKoan(`
      turns: []
    `),
    message: '"turns" must be a non-empty list of turn entries',
  },
  {
    rule: '"turns" needs at least two entries',
    yaml: bareKoan(`
      turns:
        - prompt: a
          when:
            - request: model
              response: ok
    `),
    message: '"turns" needs at least two entries — a 1-turn koan is just "when"',
  },
  {
    rule: 'each turn needs a non-empty "prompt"',
    yaml: turnsKoan(`
      - prompt: "  "
        when:
          - request: model
            response: ok
    `),
    message: 'turns[0] needs a non-empty "prompt"',
  },
  {
    rule: 'a turn entry has no unknown key',
    yaml: turnsKoan(`
      - prompt: a
        when:
          - request: model
            response: ok
        extra: 1
    `),
    message: 'turns[0] has unknown key "extra" — a turn entry carries only "prompt", "when", and "then"',
  },
  {
    rule: 'a turn\'s "when" is a non-empty list',
    yaml: turnsKoan(`
      - prompt: a
        when: []
    `),
    message: 'turns[0].when must be a non-empty list of trace steps',
  },
  {
    rule: 'a non-final turn ends with a plain text reply',
    yaml: turnsKoan(`
      - prompt: a
        when:
          - request: model
            response: { tool: x, args: {} }
    `),
    message: `turns[0].when must end with a plain text reply — an intermediate turn can only be judged "completed" by ending in one`,
  },
  {
    rule: 'every delegation is answered by a "subagent" block',
    yaml: koan(`
      when:
        - request: model
          response: { subagent: r, prompt: "go look" }
    `),
    message: `when[1]: delegation to "r" has no following "subagent" block — every delegation's conversation must be scripted`,
  },
  {
    rule: 'a nested trace (a subagent block\'s "when") is a non-empty list',
    yaml: koan(`
      when:
        - request: model
          response: { subagent: r, prompt: "go look" }
        - subagent: r
          when: []
    `),
    message: 'when[1].when must be a non-empty list of trace steps',
  },
  {
    rule: 'nothing follows a model API failure',
    yaml: koan(`
      when:
        - request: model
          response: { status: 401 }
        - request: model
          response: "too late"
    `),
    message: 'when[1]: nothing can follow a model API failure — the agent must stop',
  },
  {
    rule: 'nothing follows "abort"',
    yaml: koan(`
      when:
        - request: model
          response: ok
        - abort
        - request: model
          response: again
    `),
    message: `when[2]: nothing can follow "abort" — it must be the trace's last step`,
  },
  {
    rule: '"abort" cannot appear inside a "turns" koan',
    yaml: turnsKoan(`
      - prompt: a
        when:
          - request: model
            response: ok
          - abort
    `),
    message: `turns[0].when[1]: "abort" cannot appear inside a "turns" koan — turn-level cancellation is not supported yet`,
  },
  {
    rule: '"abort" cannot appear inside a subagent block',
    yaml: koan(`
      when:
        - request: model
          response: { subagent: r, prompt: "go look" }
        - subagent: r
          when:
            - request: model
              response: ok
            - abort
    `),
    message: `when[1].when[1]: "abort" cannot appear inside a subagent block — only the caller's own run can be aborted`,
  },
  {
    rule: '"abort" needs at least one exchange before it',
    yaml: koan(`
      when:
        - abort
    `),
    message: 'when[0]: "abort" needs at least one exchange before it in the trace',
  },
  {
    rule: 'a trace step has no unknown key',
    yaml: koan(`
      when:
        - request: model
          response: ok
          intercept: p
    `),
    message:
      `when[0] has unknown key "intercept" — a trace step is a "request" and its "response", plus a tool step's "prompt"; anything else belongs inside one of them`,
  },
  {
    rule: 'a mid-run "prompt" belongs on a tool step',
    yaml: koan(`
      when:
        - request: model
          response: ok
          prompt: p
    `),
    message: 'when[0]: "prompt" belongs on the tool step whose response is held open, not on a model request',
  },
  {
    rule: 'a mid-run "prompt" cannot appear inside a "turns" koan',
    yaml: turnsKoan(`
      - prompt: a
        when:
          - request: model
            response: { tool: x, args: {} }
          - request: { tool: x }
            response: { status: 200 }
            prompt: p
    `),
    message:
      'turns[0].when[1]: a tool step\'s "prompt" cannot appear inside a "turns" koan — a scripted turn and a prompt sent mid-run are different things',
  },
  {
    rule: 'a mid-run "prompt" cannot appear inside a subagent block',
    yaml: koan(`
      when:
        - request: model
          response: { subagent: r, prompt: "go look" }
        - subagent: r
          when:
            - request: model
              response: { tool: x, args: {} }
            - request: { tool: x }
              response: { status: 200 }
              prompt: p
    `),
    message:
      'when[1].when[1]: a tool step\'s "prompt" cannot appear inside a subagent block — only the caller\'s own run can be prompted',
  },
  {
    rule: 'a trace carries at most one mid-run "prompt"',
    yaml: koan(`
      when:
        - request: model
          response: { tool: x, args: {} }
        - request: { tool: x }
          response: { status: 200 }
          prompt: p
        - request: model
          response: { tool: y, args: {} }
        - request: { tool: y }
          response: { status: 200 }
          prompt: q
        - request: model
          response: ok
    `),
    message: 'when[3]: a trace carries at most one mid-run "prompt" — the caller sends once',
  },
  {
    rule: '"abort" and a mid-run "prompt" cannot share a trace',
    yaml: koan(`
      when:
        - request: model
          response: { tool: x, args: {} }
        - request: { tool: x }
          response: { status: 200 }
          prompt: p
        - request: model
          response: ok
        - abort
    `),
    message:
      'when: a trace carries either "abort" or a mid-run "prompt", not both — cancelling a held invocation is not scripted yet',
  },
  {
    rule: 'a mid-run "prompt" needs a model request after it',
    yaml: koan(`
      when:
        - request: model
          response: { tool: x, args: {} }
        - request: { tool: x }
          response: { status: 200 }
          prompt: p
    `),
    message: 'when[1]: a mid-run "prompt" needs a model request after it — otherwise no request carries it',
  },
  {
    rule: 'a prompt sent mid-run opens at most one queued turn',
    yaml: koan(`
      when:
        - request: model
          response: { tool: x, args: {} }
        - request: { tool: x }
          response: { status: 200 }
          prompt: p
        - request: model
          response: one
        - request: model
          response: two
        - request: model
          response: three
    `),
    message:
      'when[4]: a prompt sent mid-run opens at most one queued turn — this is the second model request to follow a text reply',
  },
  {
    rule: 'a mid-run "prompt" is a non-empty string',
    yaml: koan(`
      when:
        - request: model
          response: { tool: x, args: {} }
        - request: { tool: x }
          response: { status: 200 }
          prompt: ""
    `),
    message: 'when[1].prompt must be a non-empty string — what the caller sends while this response is held',
  },
  {
    rule: 'a subagent block has no unknown key',
    yaml: koan(`
      when:
        - request: model
          response: { subagent: r, prompt: "go look" }
        - subagent: r
          when:
            - request: model
              response: ok
          extra: 1
    `),
    message: 'when[1] has unknown key "extra" — a subagent block carries only "subagent" and "when"',
  },
  {
    rule: 'a subagent block names a non-empty delegate',
    yaml: koan(`
      when:
        - request: model
          response: { subagent: r, prompt: "go look" }
        - subagent: ""
          when:
            - request: model
              response: ok
    `),
    message: 'when[1].subagent must be a non-empty delegate name',
  },
  {
    rule: 'a subagent block matches a pending delegation',
    yaml: koan(`
      when:
        - request: model
          response: ok
        - subagent: ghost
          when:
            - request: model
              response: hi
    `),
    message: `when[1]: subagent block "ghost" has no matching pending delegation — the preceding model response must include { subagent: "ghost", prompt: ... }`,
  },
  {
    rule: "a subagent block ends with the child's final text reply",
    yaml: koan(`
      when:
        - request: model
          response: { subagent: r, prompt: "go look" }
        - subagent: r
          when:
            - request: model
              response: { tool: x, args: {} }
    `),
    message: `when[1]: a subagent block must end with the child's final text reply — it is what returns to the parent`,
  },
  {
    rule: 'a trace entry needs "request"',
    yaml: koan(`
      when:
        - response: ok
    `),
    message: 'when[0] needs "request"',
  },
  {
    rule: 'a trace entry needs "response"',
    yaml: koan(`
      when:
        - request: model
    `),
    message: 'when[0] needs "response"',
  },
  {
    rule: 'a model request cannot follow a text reply',
    yaml: koan(`
      when:
        - request: model
          response: done
        - request: model
          response: again
    `),
    message: `when[1]: a model request cannot follow a text reply here — only a later turn's first request may`,
  },
  {
    rule: 'a tool request needs a numeric "status"',
    yaml: koan(`
      when:
        - request: model
          response: { tool: x, args: {} }
        - request: { tool: x }
          response: "nope"
    `),
    message: 'when[1].response needs a numeric "status" for a tool request',
  },
  {
    rule: 'a tool request must follow a model response with a tool-call instruction',
    yaml: koan(`
      when:
        - request: model
          response: done
        - request: { tool: x }
          response: { status: 200 }
    `),
    message: 'when[1]: a tool request must follow a model response containing a tool-call instruction',
  },
  {
    rule: 'a tool request cannot close an already-closed call',
    yaml: koan(`
      when:
        - request: model
          response: { tool: x, args: {} }
        - request: { tool: x }
          response: { status: 200 }
        - request: { tool: x }
          response: { status: 200 }
    `),
    message: 'when[2]: the preceding tool-call instruction for "x" already has a tool request',
  },
  {
    rule: 'a tool request names a tool the model actually requested',
    yaml: koan(`
      when:
        - request: model
          response: { tool: x, args: {} }
        - request: { tool: y }
          response: { status: 200 }
    `),
    message: 'when[1].request.tool is "y" but the preceding model response requests "x"',
  },
  {
    rule: 'a repeated tool name in a group needs "args" to pick a call',
    yaml: koan(`
      when:
        - request: model
          response:
            - { tool: x, args: { a: 1 } }
            - { tool: x, args: { a: 2 } }
        - request: { tool: x }
          response: { status: 200 }
    `),
    message: 'when[1]: "x" appears more than once in the preceding group — write "args" to say which call this closes',
  },
  {
    rule: '"args" must match exactly one pending call',
    yaml: koan(`
      when:
        - request: model
          response:
            - { tool: x, args: { a: 1 } }
            - { tool: x, args: { a: 2 } }
        - request: { tool: x, args: { a: 3 } }
          response: { status: 200 }
    `),
    message: 'when[1]: "args" does not match exactly one of the pending "x" calls in the group',
  },
  {
    rule: 'malformed args forbid a following tool request',
    yaml: koan(`
      when:
        - request: model
          response: { tool: x, args: "{not json" }
        - request: { tool: x }
          response: { status: 200 }
    `),
    message: `when[1]: "x"'s arguments do not parse as a JSON object — argument fidelity is undefined, so the agent must refuse the call instead; no tool request can follow it`,
  },
  {
    rule: 'a trace entry\'s "request" is "model", a model with a purpose, or { tool }',
    yaml: koan(`
      when:
        - request: nonsense
          response: ok
    `),
    message: 'when[0].request must be "model", { type: model, purpose: ... }, or { tool: <name> }',
  },
  {
    rule: 'a parallel group needs at least two instructions',
    yaml: koan(`
      when:
        - request: model
          response:
            - { tool: x, args: {} }
    `),
    message: `when[0].response is a list of 1 — a parallel group needs at least two instructions; write the single "{ tool, args }" form instead`,
  },
  {
    rule: 'duplicate members in a parallel group are ambiguous',
    yaml: koan(`
      when:
        - request: model
          response:
            - { tool: x, args: { a: 1 } }
            - { tool: x, args: { a: 1 } }
    `),
    message: `when[0]: list members [0] and [1] both call "x" with the same arguments — matching a following tool request against them would be ambiguous`,
  },
  {
    rule: 'a subagent name is delegated to at most once per group',
    yaml: koan(`
      when:
        - request: model
          response:
            - { subagent: r, prompt: "go a" }
            - { subagent: r, prompt: "go b" }
    `),
    message: 'when[0]: two delegations to "r" in one turn — a subagent name may be delegated to at most once per trace',
  },
  {
    rule: 'a delegation response does not mix in other forms',
    yaml: koan(`
      when:
        - request: model
          response: { subagent: r, prompt: "go", status: 200 }
    `),
    message: 'when[0].response mixes a delegation instruction with other response forms',
  },
  {
    rule: 'a tool-call response does not mix in "status"',
    yaml: koan(`
      when:
        - request: model
          response: { tool: x, args: {}, status: 200 }
    `),
    message: 'when[0].response mixes a tool-call instruction with "status"',
  },
  {
    rule: 'a model API failure cannot appear inside a subagent block',
    yaml: koan(`
      when:
        - request: model
          response: { subagent: r, prompt: "go look" }
        - subagent: r
          when:
            - request: model
              response: { status: 401 }
    `),
    message: 'when[1].when[0]: a model API failure cannot appear inside a subagent block — it ends the whole run',
  },
  {
    rule: "a model API failure's status is a non-retryable 4xx",
    yaml: koan(`
      when:
        - request: model
          response: { status: 429 }
    `),
    message: 'when[0].response.status must be a non-retryable 4xx (not 408/429) for a model API failure',
  },
  {
    rule: 'a model response is a reply, instruction, group, or failure',
    yaml: koan(`
      when:
        - request: model
          response: 42
    `),
    message: `when[0].response for a model request must be a reply string, { tool, args }, { subagent, prompt }, a list of instructions, or { status }`,
  },
  {
    rule: 'a tool-call instruction needs "tool"',
    yaml: koan(`
      when:
        - request: model
          response:
            - { args: {} }
            - { tool: y, args: {} }
    `),
    message: 'when[0][0] needs "tool"',
  },
  {
    rule: 'a tool-call instruction has no unknown key',
    yaml: koan(`
      when:
        - request: model
          response: { tool: x, args: {}, extra: 1 }
    `),
    message: 'when[0] has unknown key "extra" — a tool-call instruction carries only "tool" and "args"',
  },
  {
    rule: '"args" is a mapping or a wire string',
    yaml: koan(`
      when:
        - request: model
          response: { tool: x, args: 42 }
    `),
    message: 'when[0].args must be a mapping (JSON-encoding sugar) or a string (the verbatim wire arguments)',
  },
  {
    rule: 'a delegation names a non-empty "subagent"',
    yaml: koan(`
      when:
        - request: model
          response: { subagent: "" }
    `),
    message: `when[0] needs a non-empty "subagent" (the delegate's name)`,
  },
  {
    rule: 'a delegation instruction has no unknown key',
    yaml: koan(`
      when:
        - request: model
          response: { subagent: r, prompt: "go", extra: 1 }
    `),
    message: 'when[0] has unknown key "extra" — a delegation instruction carries only "subagent" and "prompt"',
  },
  {
    rule: 'a delegation needs a non-empty "prompt"',
    yaml: koan(`
      when:
        - request: model
          response: { subagent: r, prompt: "   " }
    `),
    message: `when[0] needs a non-empty "prompt" (the briefing)`,
  },
  {
    rule: 'a subagent name is delegated to at most once per trace',
    yaml: bareKoan(`
      prompt: "Do two things."
      when:
        - request: model
          response: { subagent: r, prompt: "First." }
        - subagent: r
          when:
            - request: model
              response: "first done"
        - request: model
          response: { subagent: r, prompt: "Second." }
        - subagent: r
          when:
            - request: model
              response: "second done"
        - request: model
          response: ok
    `),
    message: 'when[3]: subagent "r" already has a conversation in this trace — a subagent conversation cannot be continued yet',
  },
  {
    rule: 'openings (the prompt, every briefing) must be mutually distinct',
    yaml: bareKoan(`
      prompt: "Look things up."
      when:
        - request: model
          response: { subagent: r, prompt: "Look things up." }
        - subagent: r
          when:
            - request: model
              response: done
        - request: model
          response: ok
    `),
    message: `when: prompt and the briefing of subagent "r" are not distinct — no briefing may equal or contain another briefing or the prompt, since requests are attributed to conversations by their opening`,
  },
  {
    rule: '"given.context" needs both a window and a policy',
    yaml: koan(`
      given:
        context:
          window: 100
      when:
        - request: model
          response: ok
    `),
    message: '"given.context.compaction" must be "off" or a percentage of the window, like "90%"',
  },
  {
    rule: '"used_tokens" needs a declared window',
    yaml: koan(`
      when:
        - request: model
          response: { body: ok, used_tokens: 50 }
    `),
    message: 'when[0]: "used_tokens" needs "given.context.window" — there is no window for it to be a part of',
  },
  {
    rule: '"used_tokens" fits the window',
    yaml: koan(`
      given:
        context:
          window: 100
          compaction: "off"
      when:
        - request: model
          response: { body: ok, used_tokens: 101 }
    `),
    message: 'when[0]: used_tokens (101) is larger than given.context.window (100)',
  },
  {
    rule: 'a conversation shrinks only where a compaction folds it down',
    yaml: koan(`
      given:
        context:
          window: 100
          compaction: "off"
      when:
        - request: model
          response: { body: { tool: x, args: {} }, used_tokens: 50 }
        - request: { tool: x }
          response: { status: 200 }
        - request: model
          response: { body: ok, used_tokens: 10 }
    `),
    message:
      'when[2]: used_tokens falls from 50 to 10 — a conversation shrinks only where a compaction folds it down',
  },
  {
    rule: 'a compaction belongs at the start of a later turn',
    yaml: koan(`
      given:
        context:
          window: 100
          compaction: "90%"
      when:
        - request: model
          response: { body: { tool: x, args: {} }, used_tokens: 95 }
        - request: { type: model, purpose: compaction }
          response: { body: "so far", used_tokens: 10, compaction: completed }
        - request: model
          response: ok
    `),
    message:
      'when[1]: a compaction belongs at the start of a later turn of a "turns:" koan — a run folds the conversation down by the time the next turn\'s first model request goes out, and where inside the turn before it is the agent\'s own business',
  },
  {
    rule: 'a turn past the threshold asks for no further model request',
    yaml: koan(`
      given:
        context:
          window: 100
          compaction: "90%"
      when:
        - request: model
          response: { body: { tool: x, args: {} }, used_tokens: 95 }
        - request: { tool: x }
          response: { status: 200 }
        - request: model
          response: ok
    `),
    message:
      'when[2]: the conversation reached 95 of 100 tokens, at or above the threshold of 90, earlier in this turn — a turn cannot ask for another model request past its threshold, since when the agent folds it down before the next turn is the agent\'s own business',
  },
  {
    rule: 'a turn opening past the threshold opens with a compaction',
    yaml: `name: x\n${dedent(`
      given:
        context:
          window: 100
          compaction: "90%"
      turns:
        - prompt: a
          when:
            - request: model
              response: { body: ok, used_tokens: 95 }
        - prompt: b
          when:
            - request: model
              response: ok
    `)}`,
    message:
      'turns[1].when[0]: the conversation carries 95 of 100 tokens into this turn, at or above the threshold of 90 — it must open with a compaction',
  },
  {
    rule: 'a compaction needs something to have asked for it',
    yaml: `name: x\n${dedent(`
      given:
        context:
          window: 100
          compaction: "off"
      turns:
        - prompt: a
          when:
            - request: model
              response: { body: ok, used_tokens: 95 }
        - prompt: b
          when:
            - request: { type: model, purpose: compaction }
              response: { body: "so far", used_tokens: 10, compaction: completed }
            - request: model
              response: ok
    `)}`,
    message:
      'turns[1].when[0]: nothing has asked for a fold here — the conversation is at 95 tokens and the run declares no threshold, and the caller did not ask after the turn before',
  },
  {
    rule: 'a compaction says what the conversation shrank to',
    yaml: `name: x\n${dedent(`
      given:
        context:
          window: 100
          compaction: "90%"
      turns:
        - prompt: a
          when:
            - request: model
              response: { body: ok, used_tokens: 95 }
        - prompt: b
          when:
            - request: { type: model, purpose: compaction }
              response: { body: "so far", compaction: completed }
            - request: model
              response: ok
    `)}`,
    message:
      'turns[1].when[0].response needs "used_tokens" — what the conversation shrank to, which is half of what a fold does',
  },
  {
    rule: 'a compaction says how the run reported its ending',
    yaml: `name: x\n${dedent(`
      given:
        context:
          window: 100
          compaction: "90%"
      turns:
        - prompt: a
          when:
            - request: model
              response: { body: ok, used_tokens: 95 }
        - prompt: b
          when:
            - request: { type: model, purpose: compaction }
              response: { body: "so far", used_tokens: 10 }
            - request: model
              response: ok
    `)}`,
    message:
      'turns[1].when[0].response needs "compaction: completed" or "compaction: failed" — how the run reported this fold\'s ending to its caller',
  },
  {
    rule: 'a trace fits the model-request budget',
    yaml: koan(`
      given:
        limits:
          max_model_requests: 1
      when:
        - request: model
          response: { tool: x, args: {} }
        - request: { tool: x }
          response: { status: 200 }
        - request: model
          response: done
    `),
    message: 'when scripts 2 model requests, more than given.limits.max_model_requests (1) permits',
  },
];

it.each(rows)('rejects: $rule', ({ yaml, message }) => {
  const result = parseKoanFile(parseYaml(yaml));
  expect(isProblem(result) ? result.message : undefined).toBe(message);
});
