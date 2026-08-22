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
          run:
            model_requests: 3
          extra: 1
      when:
        - request: model
          response: ok
    `),
    message: '"given.limits" has unknown key "extra" — a budget is written under its scope (allowed: run, prompt)',
  },
  {
    rule: 'a flat budget names its scope instead',
    yaml: koan(`
      given:
        limits:
          max_model_requests: 3
      when:
        - request: model
          response: ok
    `),
    message: '"given.limits" has unknown key "max_model_requests" — a budget is written under its scope (allowed: run, prompt)',
  },
  {
    rule: '"given.limits.run" carries only its own budget',
    yaml: koan(`
      given:
        limits:
          run:
            duration_ms: 2000
      when:
        - request: model
          response: ok
    `),
    message: '"given.limits.run" has unknown key "duration_ms" (allowed: model_requests, delegation_depth)',
  },
  {
    rule: '"given.limits.run" declares no budget when empty',
    yaml: koan(`
      given:
        limits:
          run: {}
      when:
        - request: model
          response: ok
    `),
    message: '"given.limits.run" declares no budget',
  },
  {
    rule: '"given.limits" declares no budget when empty',
    yaml: koan(`
      given:
        limits: {}
      when:
        - request: model
          response: ok
    `),
    message: '"given.limits" declares no budget',
  },
  {
    rule: '"given.limits.run.model_requests" is a positive integer',
    yaml: koan(`
      given:
        limits:
          run:
            model_requests: 0
      when:
        - request: model
          response: ok
    `),
    message: '"given.limits.run.model_requests" must be a positive integer',
  },
  {
    rule: '"given.limits.run.delegation_depth" is a positive integer',
    yaml: koan(`
      given:
        limits:
          run:
            delegation_depth: 0
      when:
        - request: model
          response: ok
    `),
    message: '"given.limits.run.delegation_depth" must be a positive integer',
  },
  {
    rule: '"given.limits.prompt.duration_ms" is a positive integer',
    yaml: koan(`
      given:
        limits:
          prompt:
            duration_ms: 0
      when:
        - request: model
          response: ok
    `),
    message: '"given.limits.prompt.duration_ms" must be a positive integer',
  },
  {
    rule: '"given.subagents" is a mapping of name to declaration',
    yaml: koan(`
      given:
        subagents: nope
      when:
        - request: model
          response: ok
    `),
    message: '"given.subagents" must be a mapping of subagent name to declaration',
  },
  {
    rule: 'a "given.subagents" entry has no unknown key',
    yaml: koan(`
      given:
        subagents:
          researcher:
            description: x
      when:
        - request: model
          response: ok
    `),
    message: 'given.subagents["researcher"] has unknown key "description" (allowed: context)',
  },
  {
    rule: 'a "given.subagents" entry\'s "context" is well-formed',
    yaml: koan(`
      given:
        subagents:
          researcher:
            context:
              window: 0
              compaction: "off"
      when:
        - request: model
          response: ok
    `),
    message: '"given.subagents["researcher"].context.window" must be a positive integer (the window in tokens)',
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
    message: 'turns[0] has unknown key "extra" — a prompt entry carries only "prompt", "when", "one_of", and "then"',
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
    message: 'when[1]: nothing can follow a model API failure — the conversation it refused must stop',
  },
  {
    rule: 'nothing follows a tool step answered "never"',
    yaml: koan(`
      given:
        limits:
          prompt:
            duration_ms: 2000
      when:
        - request: model
          response: { tool: x, args: {} }
        - request: { tool: x }
          response: never
        - request: model
          response: "too late"
    `),
    message: 'when[2]: nothing can follow "never" — the invocation it answers is held open forever',
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
    message: `when[2]: nothing can follow "abort" — it must be the trace's last step, "retry: abort", or "crash"`,
  },
  {
    rule: 'two bare "abort"s in a row still falls to "nothing follows"',
    yaml: koan(`
      when:
        - request: model
          response: ok
        - abort
        - abort
    `),
    message: `when[2]: nothing can follow "abort" — it must be the trace's last step, "retry: abort", or "crash"`,
  },
  {
    rule: 'a real step with a stray "retry" key after "abort" still falls to "nothing follows"',
    yaml: koan(`
      when:
        - request: model
          response: ok
        - abort
        - request: model
          response: again
          retry: prompt
    `),
    message: `when[2]: nothing can follow "abort" — it must be the trace's last step, "retry: abort", or "crash"`,
  },
  {
    rule: 'a retry step after "abort" has no other key',
    yaml: koan(`
      when:
        - request: model
          response: { tool: x, args: {} }
        - request: { tool: x }
          response: { status: 200 }
        - abort
        - retry: abort
          twice: true
    `),
    message: 'when[3] has unknown key "twice" — a retry step is only "retry"',
  },
  {
    rule: '"retry: abort" is the only retry that may follow "abort"',
    yaml: koan(`
      when:
        - request: model
          response: { tool: x, args: {} }
        - request: { tool: x }
          response: { status: 200 }
        - abort
        - retry: prompt
    `),
    message: 'when[3]: "retry: abort" is the only retry that may follow "abort" — write "retry: abort"',
  },
  {
    rule: '"retry: abort" must directly follow "abort"',
    yaml: koan(`
      when:
        - request: model
          response: { tool: x, args: {} }
        - request: { tool: x }
          response: { status: 200 }
        - retry: abort
    `),
    message: 'when[2]: "retry: abort" must directly follow "abort" — it retries the caller\'s abort delivery, not a held invocation',
  },
  {
    rule: '"retry: abort" only follows a live abort',
    yaml: koan(`
      when:
        - request: model
          response: ok
        - abort
        - retry: abort
    `),
    message: 'when: "retry: abort" only follows a live abort — a late one already tests nothing more by repeating',
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
    rule: 'queued turns cannot outnumber the prompts sent mid-run',
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
          response: one
        - request: model
          response: two
        - request: model
          response: three
        - request: model
          response: four
    `),
    message:
      'when[7]: a prompt sent mid-run opens at most one queued turn each — more model requests follow text replies than prompts were sent',
  },
  {
    rule: 'a child cut off mid-flight settles unless the abort follows it directly',
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
        - request: model
          response: ok
        - abort
    `),
    message:
      "when[1]: a subagent block must end with the child's final text reply or its model API failure — what came of the delegation is what returns to the parent",
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
      'when[4]: a prompt sent mid-run opens at most one queued turn each — more model requests follow text replies than prompts were sent',
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
    rule: '"retry" is written with its object',
    yaml: koan(`
      when:
        - request: model
          response: { tool: x, args: {} }
        - request: { tool: x }
          response: { status: 200 }
        - retry
        - request: model
          response: ok
    `),
    message: 'when[2]: "retry" names what the caller re-sends — write "retry: prompt"',
  },
  {
    rule: '"retry" re-sends only the prompt submission',
    yaml: koan(`
      when:
        - request: model
          response: { tool: x, args: {} }
        - request: { tool: x }
          response: { status: 200 }
        - retry: nonsense
        - request: model
          response: ok
    `),
    message: 'when[2].retry names what the caller re-sends — only "prompt" (this turn\'s own creation request) is supported',
  },
  {
    rule: 'a retry step has no other key',
    yaml: koan(`
      when:
        - request: model
          response: { tool: x, args: {} }
        - request: { tool: x }
          response: { status: 200 }
        - retry: prompt
          twice: true
        - request: model
          response: ok
    `),
    message: 'when[2] has unknown key "twice" — a retry step is only "retry"',
  },
  {
    rule: '"retry" cannot appear inside a "turns" koan',
    yaml: turnsKoan(`
      - prompt: a
        when:
          - request: model
            response: { tool: x, args: {} }
          - request: { tool: x }
            response: { status: 200 }
          - retry: prompt
          - request: model
            response: ok
    `),
    message: 'turns[0].when[2]: "retry" cannot appear inside a "turns" koan — retrying a follow-up prompt is not supported yet',
  },
  {
    rule: '"retry" cannot appear inside a subagent block',
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
            - retry: prompt
            - request: model
              response: ok
    `),
    message: 'when[1].when[2]: "retry" cannot appear inside a subagent block — only the caller\'s own request can be retried',
  },
  {
    rule: '"retry" directly follows a tool step',
    yaml: koan(`
      when:
        - request: model
          response: { tool: x, args: {} }
        - request: { tool: x }
          response: { status: 200 }
        - request: model
          response: ok
        - retry: prompt
        - request: model
          response: ok again
    `),
    message: 'when[3]: "retry" must directly follow a tool step — its held invocation is what proves the run is still running when the resend lands',
  },
  {
    rule: '"retry" cannot follow a tool step answered "never"',
    yaml: koan(`
      given:
        limits: { prompt: { duration_ms: 2000 } }
      when:
        - request: model
          response: { tool: x, args: {} }
        - request: { tool: x }
          response: never
        - retry: prompt
    `),
    message: 'when[2]: "retry" cannot follow a tool step answered "never" — its invocation is never released',
  },
  {
    rule: 'a held invocation carries one caller action',
    yaml: koan(`
      when:
        - request: model
          response: { tool: x, args: {} }
        - request: { tool: x }
          response: { status: 200 }
          prompt: p
        - retry: prompt
        - request: model
          response: ok
    `),
    message: 'when[2]: a held invocation carries one caller action — this tool step already carries "prompt"',
  },
  {
    rule: 'a tool step carries at most one retry',
    yaml: koan(`
      when:
        - request: model
          response: { tool: x, args: {} }
        - request: { tool: x }
          response: { status: 200 }
        - retry: prompt
        - retry: prompt
        - request: model
          response: ok
    `),
    message: 'when[3]: a held invocation carries one caller action — this tool step already carries "retry"',
  },
  {
    rule: 'a trailing "retry: prompt" cannot follow a model API failure',
    yaml: koan(`
      when:
        - request: model
          response: { tool: x, args: {} }
        - request: { tool: x }
          response: { status: 200 }
        - request: model
          response: { status: 400 }
        - retry: prompt
    `),
    message:
      'when[3]: a trailing "retry: prompt" cannot follow a model API failure — the resend of a FAILED run\'s creation is a different case this format does not script yet',
  },
  {
    rule: 'a late "retry: prompt" cannot share a trace with "abort"',
    yaml: koan(`
      when:
        - request: model
          response: { tool: x, args: {} }
        - request: { tool: x }
          response: { status: 200 }
        - request: model
          response: ok
        - retry: prompt
        - abort
    `),
    message: 'when[3]: a late "retry: prompt" cannot share a trace with "abort" — one ending per trace is all this format scripts',
  },
  {
    rule: 'a late "retry: prompt" cannot share a trace with "crash"',
    yaml: koan(`
      when:
        - request: model
          response: ok
        - crash
        - request: model
          response: ok again
        - retry: prompt
    `),
    message: 'when[3]: a late "retry: prompt" cannot share a trace with "crash" — one ending per trace is all this format scripts',
  },
  {
    rule: '"crash" cannot appear inside a turn\'s own trace',
    yaml: turnsKoan(`
      - prompt: a
        when:
          - request: model
            response: ok
          - crash
    `),
    message:
      'turns[0].when[1]: "crash" cannot appear inside a turn\'s own trace — a death inside a prompt\'s own work is not supported in a "turns" koan yet; only the seam between turns is, written as an entry of "turns" itself',
  },
  {
    rule: 'a turn forbids "crash" at every depth — a nested subagent block included',
    yaml: turnsKoan(`
      - prompt: a
        when:
          - request: model
            response: { subagent: helper, prompt: go }
          - subagent: helper
            when:
              - request: model
                response: { tool: t, args: {} }
              - crash
              - request: model
                response: done
          - request: model
            response: ok
    `),
    message:
      'turns[0].when[1].when[1]: "crash" cannot appear inside a turn\'s own trace — a death inside a prompt\'s own work is not supported in a "turns" koan yet; only the seam between turns is, written as an entry of "turns" itself',
  },
  {
    rule: 'a bare "crash" before "abort" still cannot share a trace with it',
    yaml: koan(`
      when:
        - request: model
          response: ok
        - crash
        - abort
    `),
    message:
      'when[1]: "crash" cannot share a trace with "abort" — the only pairing this format admits is a bare "crash" ' +
      'directly after a live "abort", the trace\'s last two steps; anywhere else, one ending per run is all this format scripts',
  },
  {
    rule: 'a tool step answered "crash" before "abort" still cannot share a trace with it',
    yaml: koan(`
      when:
        - request: model
          response: { tool: x, args: {} }
        - request: { tool: x }
          response: crash
        - abort
    `),
    message:
      'when[1]: "crash" cannot share a trace with "abort" — the only pairing this format admits is a bare "crash" ' +
      'directly after a live "abort", not a tool step\'s own; anywhere else, one ending per run is all this format scripts',
  },
  {
    rule: '"crash" after "abort" only follows a live abort',
    yaml: koan(`
      when:
        - request: model
          response: ok
        - abort
        - crash
    `),
    message: 'when: "crash" only follows a live abort — a late one already settled, and a death after it tests nothing new',
  },
  {
    rule: '"crash" after "abort" still owes the one-crash-per-koan rule',
    yaml: koan(`
      when:
        - request: model
          response: { subagent: r, prompt: "go" }
        - subagent: r
          when:
            - request: model
              response: { tool: t, args: {} }
            - request: { tool: t }
              response: { status: 200 }
            - crash
            - request: model
              response: done
        - request: model
          response: { tool: x, args: {} }
        - request: { tool: x }
          response: { status: 200 }
        - abort
        - crash
    `),
    message: 'when[5]: a second "crash" — one death per koan, wherever it lands',
  },
  {
    rule: 'a koan carries at most one "crash"',
    yaml: koan(`
      when:
        - request: model
          response: ok
        - crash
        - request: model
          response: ok
        - crash
    `),
    message: 'when[3]: a second "crash" — one death per koan, wherever it lands',
  },
  {
    rule: 'a koan carries at most one "crash", across the main trace and a subagent block',
    yaml: koan(`
      when:
        - request: model
          response: ok
        - crash
        - request: model
          response: { subagent: r, prompt: "go look" }
        - subagent: r
          when:
            - request: model
              response: ok
            - crash
    `),
    message: 'when[3].when[1]: a second "crash" — one death per koan, wherever it lands',
  },
  {
    rule: 'a tool step answered "crash" admits at most one bare "crash" after it too',
    yaml: koan(`
      when:
        - request: model
          response: { tool: x, args: {} }
        - request: { tool: x }
          response: crash
        - request: model
          response: { tool: y, args: {} }
        - request: { tool: y }
          response: crash
    `),
    message: 'when[3]: a second "crash" — one death per koan, wherever it lands',
  },
  {
    rule: 'a bare "crash" following a tool step answered "crash" must come directly after it',
    yaml: koan(`
      when:
        - request: model
          response: { tool: x, args: {} }
        - request: { tool: x }
          response: crash
        - request: model
          response: ok
        - crash
    `),
    message:
      'when[3]: a second "crash" is admitted only directly after the tool step it recovers from — landing anywhere else is just a second, ungrounded death',
  },
  {
    rule: 'the tool-crash/bare-crash pair is admitted once, not chained further',
    yaml: koan(`
      when:
        - request: model
          response: { tool: x, args: {} }
        - request: { tool: x }
          response: crash
        - crash
        - crash
    `),
    message: 'when[3]: a second "crash" — one death per koan, wherever it lands',
  },
  {
    rule: 'a tool step answered "crash" cannot appear inside a "turns" koan',
    yaml: turnsKoan(`
      - prompt: a
        when:
          - request: model
            response: { tool: x, args: {} }
          - request: { tool: x }
            response: crash
    `),
    message:
      'turns[0].when[1]: a tool step answered "crash" cannot appear inside a "turns" koan — a mid-invocation death is not supported here yet, and the "- crash" entry of "turns" scripts a different death: between two turns, with nothing in flight',
  },
  {
    rule: 'a tool step answered "crash" cannot appear inside a subagent block',
    yaml: koan(`
      when:
        - request: model
          response: { subagent: r, prompt: "go look" }
        - subagent: r
          when:
            - request: model
              response: { tool: x, args: {} }
            - request: { tool: x }
              response: crash
    `),
    message:
      'when[1].when[1]: a tool step answered "crash" cannot appear inside a subagent block — the process that dies is the whole agent\'s',
  },
  {
    rule: '"crash" cannot open a "turns" koan',
    yaml: bareKoan(`
      turns:
        - crash
        - prompt: a
          when:
            - request: model
              response: ok
    `),
    message: 'turns[0]: "crash" cannot open the koan — the record it tests is written by the turns before it',
  },
  {
    rule: '"crash" cannot be the last entry of "turns"',
    yaml: bareKoan(`
      turns:
        - prompt: a
          when:
            - request: model
              response: ok
        - crash
    `),
    message: 'turns[1]: nothing follows this "crash" — a koan that ends at the death tests nothing about recovery',
  },
  {
    rule: '"turns" carries at most one "crash"',
    yaml: bareKoan(`
      turns:
        - prompt: a
          when:
            - request: model
              response: ok
        - crash
        - prompt: b
          when:
            - request: model
              response: ok
        - crash
        - prompt: c
          when:
            - request: model
              response: ok
    `),
    message: 'turns[3]: a second "crash" — one death per koan; what survives it is the same record however often you kill the process',
  },
  {
    rule: 'a tool step answered "crash" cannot carry "prompt"',
    yaml: koan(`
      when:
        - request: model
          response: { tool: x, args: {} }
        - request: { tool: x }
          response: crash
          prompt: p
    `),
    message: 'when[1]: a tool step answered "crash" cannot carry "prompt" — the process the delivery would reach is being killed',
  },
  {
    rule: '"retry" cannot follow a tool step answered "crash"',
    yaml: koan(`
      when:
        - request: model
          response: { tool: x, args: {} }
        - request: { tool: x }
          response: crash
        - retry: prompt
    `),
    message: 'when[2]: "retry" cannot follow a tool step answered "crash" — the process the resend would reach is being killed',
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
    message: `when[1]: a subagent block must end with the child's final text reply or its model API failure — what came of the delegation is what returns to the parent`,
  },
  {
    rule: 'a subagent block\'s name must be a "given.subagents" key, once the run declares a roster',
    yaml: koan(`
      given:
        subagents:
          researcher: {}
      when:
        - request: model
          response: { subagent: researcher, prompt: "go look" }
        - subagent: field-scout
          when:
            - request: model
              response: ok
    `),
    message: `when[1]: subagent block "field-scout" is not in given.subagents — when the run declares its delegates, a conversation can only belong to one of them`,
  },
  {
    rule: 'a declared roster still requires a block for a delegation to one of its own keys',
    yaml: koan(`
      given:
        subagents:
          researcher: {}
      when:
        - request: model
          response: { subagent: researcher, prompt: "go look" }
    `),
    message: `when[1]: delegation to "researcher" has no following "subagent" block — every delegation's conversation must be scripted`,
  },
  {
    rule: 'a declared roster still refuses a delegation to a name outside it, even when a block follows',
    yaml: koan(`
      given:
        subagents:
          researcher: {}
      when:
        - request: model
          response: { subagent: field-scout, prompt: "go look" }
        - subagent: field-scout
          when:
            - request: model
              response: ok
    `),
    message: `when[1]: subagent block "field-scout" is not in given.subagents — when the run declares its delegates, a conversation can only belong to one of them`,
  },
  {
    rule: 'a declared delegation_depth still refuses a delegation past it, even for a declared name, even when a block follows',
    yaml: koan(`
      given:
        subagents:
          researcher: {}
          helper: {}
        limits:
          run:
            delegation_depth: 1
      when:
        - request: model
          response: { subagent: researcher, prompt: "go look" }
        - subagent: researcher
          when:
            - request: model
              response: { subagent: helper, prompt: "help me" }
            - subagent: helper
              when:
                - request: model
                  response: ok
            - request: model
              response: ok
    `),
    message: `when[1].when[1]: subagent block "helper" scripts a conversation given.limits.run.delegation_depth (1) forbids opening — a delegation issued from depth 1 is refused, not answered`,
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
    message:
      'when[1].response needs a numeric "status" for a tool request, "disconnect" for a connection severed without one, "never" for an invocation accepted and never answered, or "crash" for the agent\'s process killed while it is in flight',
  },
  {
    rule: '"never" needs a declared "given.limits.prompt.duration_ms"',
    yaml: koan(`
      when:
        - request: model
          response: { tool: x, args: {} }
        - request: { tool: x }
          response: never
    `),
    message: 'when[1]: "never" needs "given.limits.prompt.duration_ms" or a "timeout_ms" on the tool — nothing else ends the wait',
  },
  {
    rule: 'a tool "timeout_ms" is a positive integer of milliseconds',
    yaml: koan(`
      given:
        tools:
          x:
            timeout_ms: -5
            input_schema: { type: object }
      when:
        - request: model
          response: ok
    `),
    message: 'given.tools["x"].timeout_ms must be a positive integer of milliseconds',
  },
  {
    rule: 'a tool step answered "never" cannot carry "prompt"',
    yaml: koan(`
      given:
        limits:
          prompt:
            duration_ms: 2000
      when:
        - request: model
          response: { tool: x, args: {} }
        - request: { tool: x }
          response: never
          prompt: hello
    `),
    message: 'when[1]: a tool step answered "never" cannot carry "prompt" — its invocation is never released',
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
    rule: "a model API failure ends the child's own conversation too",
    yaml: koan(`
      when:
        - request: model
          response: { subagent: r, prompt: "go look" }
        - subagent: r
          when:
            - request: model
              response: { status: 401 }
            - request: model
              response: "too late"
    `),
    message: 'when[1].when[1]: nothing can follow a model API failure — the conversation it refused must stop',
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
    rule: 'every declared subagent is delegated to somewhere in the koan',
    yaml: koan(`
      given:
        subagents:
          researcher:
            context:
              window: 100
              compaction: "off"
      when:
        - request: model
          response: ok
    `),
    message:
      'given.subagents["researcher"]: no trace delegates to a subagent of this name — a declaration must provision a delegation the koan scripts',
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
    rule: "a delegate's used_tokens is checked against its own declared window, not the run's",
    yaml: bareKoan(`
      prompt: "Have the researcher look into it."
      given:
        subagents:
          researcher:
            context:
              window: 100
              compaction: "off"
      when:
        - request: model
          response: { subagent: researcher, prompt: "Look into it." }
        - subagent: researcher
          when:
            - request: model
              response: { body: done, used_tokens: 101 }
        - request: model
          response: ok
    `),
    message: 'when[1].when[0]: used_tokens (101) is larger than given.subagents["researcher"].context.window (100)',
  },
  {
    rule: "a delegate's own threshold, once crossed, forbids a further model request the same way the run's does",
    yaml: bareKoan(`
      prompt: "Have the researcher look into it."
      given:
        subagents:
          researcher:
            context:
              window: 100
              compaction: "90%"
      when:
        - request: model
          response: { subagent: researcher, prompt: "Look into it." }
        - subagent: researcher
          when:
            - request: model
              response: { body: { tool: x, args: {} }, used_tokens: 95 }
            - request: { tool: x }
              response: { status: 200 }
            - request: model
              response: ok
        - request: model
          response: ok
    `),
    message:
      'when[1].when[2]: the conversation reached 95 of 100 tokens, at or above the threshold of 90, earlier in this turn — a turn cannot ask for another model request past its threshold, since when the agent folds it down before the next turn is the agent\'s own business',
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
      'when[1]: a compaction belongs at the start of a later turn of a "turns:" koan, or inside a subagent block, where a delegate\'s own declared threshold puts one — a run folds the conversation down by the time the next turn\'s first model request goes out, and where inside the turn before it is the agent\'s own business',
  },
  {
    rule: 'a compaction at the very start of a plain "when:" koan\'s main trace is still rejected — the relaxation is subagent-only, not position-only',
    yaml: koan(`
      given:
        context:
          window: 100
          compaction: "90%"
      when:
        - request: { type: model, purpose: compaction }
          response: { body: "so far", used_tokens: 10, compaction: completed }
        - request: model
          response: ok
    `),
    message:
      'when[0]: a compaction belongs at the start of a later turn of a "turns:" koan, or inside a subagent block, where a delegate\'s own declared threshold puts one — a run folds the conversation down by the time the next turn\'s first model request goes out, and where inside the turn before it is the agent\'s own business',
  },
  {
    rule: 'a compaction inside an undeclared delegate\'s block has nothing asking for it',
    yaml: bareKoan(`
      prompt: "Have the researcher look into it."
      when:
        - request: model
          response: { subagent: researcher, prompt: "Look into it." }
        - subagent: researcher
          when:
            - request: { type: model, purpose: compaction }
              response: { body: "so far", used_tokens: 10, compaction: completed }
            - request: model
              response: done
        - request: model
          response: ok
    `),
    message:
      'when[1].when[0]: nothing has asked for a fold here — the conversation is at 0 tokens and the run declares no threshold for delegate "researcher", and the caller did not ask before this turn',
  },
  {
    rule: "a compaction inside a declared delegate's block below its threshold has nothing asking for it",
    yaml: bareKoan(`
      prompt: "Have the researcher look into it."
      given:
        subagents:
          researcher:
            context:
              window: 100
              compaction: "90%"
      when:
        - request: model
          response: { subagent: researcher, prompt: "Look into it." }
        - subagent: researcher
          when:
            - request: { type: model, purpose: compaction }
              response: { body: "so far", used_tokens: 10, compaction: completed }
            - request: model
              response: done
        - request: model
          response: ok
    `),
    message:
      'when[1].when[0]: nothing has asked for a fold here — the conversation is at 0 tokens, below the threshold of 90, and the caller did not ask before this turn',
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
      'turns[1].when[0]: nothing has asked for a fold here — the conversation is at 95 tokens and the run declares no threshold, and the caller did not ask before this turn',
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
    rule: 'a fold that completed is followed by a model request, unless it ends the trace',
    yaml: `name: x\n${dedent(`
      given:
        context:
          window: 100
          compaction: "off"
      turns:
        - prompt: a
          when:
            - request: model
              response: { body: ok, used_tokens: 10 }
        - compact: true
          when:
            - request: { type: model, purpose: compaction }
              response: { body: "so far", used_tokens: 5, compaction: completed }
        - compact: true
          when:
            - request: { type: model, purpose: compaction }
              response: { body: "so far, again", used_tokens: 4, compaction: completed }
    `)}`,
    message:
      'turns[1]: a compaction needs a model request after it — otherwise no request carries its summary',
  },
  {
    rule: '"compact" is the caller\'s, not a step of the trace',
    yaml: koan(`
      when:
        - compact
        - request: model
          response: ok
    `),
    message: `when[0]: "compact" is the caller's, not a step of the trace — write it as a turn's own "compact: true"`,
  },
  {
    rule: 'an ask\'s "compact" is true or what it asked the fold to keep',
    yaml: turnsKoan(`
      - compact: 3
        when:
          - request: model
            response: ok
    `),
    message:
      'turns[0].compact must be true, or what the caller asked the fold to keep — the ask either says how or does not',
  },
  {
    rule: 'an ask that says nothing is written "compact: true"',
    yaml: turnsKoan(`
      - compact: "  "
        when:
          - request: model
            response: ok
    `),
    message: 'turns[0].compact is empty — an ask that says nothing about the fold is written "compact: true"',
  },
  {
    rule: 'an asking entry\'s "retry" is "compact"',
    yaml: turnsKoan(`
      - compact: true
        retry: nonsense
        when:
          - request: model
            response: ok
    `),
    message:
      'turns[0].retry names what the caller re-sends — only "compact" (this same ask, delivered again) is supported on an entry asking for a fold',
  },
  {
    rule: '"retry" cannot appear on a prompt entry',
    yaml: turnsKoan(`
      - prompt: a
        retry: compact
        when:
          - request: model
            response: ok
    `),
    message: 'turns[0] has unknown key "retry" — a prompt entry carries only "prompt", "when", "one_of", and "then"',
  },
  {
    rule: 'a koan cannot open with an ask',
    yaml: turnsKoan(`
      - compact: true
        when:
          - request: model
            response: ok
    `),
    message: `turns[0].compact: the caller asks a run that has already answered — an ask cannot open a koan`,
  },
  {
    rule: 'an ask brings about a fold and nothing else',
    yaml: `name: x\n${dedent(`
      given:
        context:
          window: 100
          compaction: "off"
      turns:
        - prompt: a
          when:
            - request: model
              response: { body: ok, used_tokens: 10 }
        - compact: true
          when:
            - request: model
              response: ok
    `)}`,
    message:
      'turns[1].when scripts 1 step(s) — an ask brings about the fold and nothing else, since without a prompt there is no other work',
  },
  {
    rule: "a fold's body list needs at least two summaries",
    yaml: `name: x\n${dedent(`
      turns:
        - prompt: a
          when:
            - request: model
              response: ok
        - compact: true
          when:
            - request: { type: model, purpose: compaction }
              response: { body: ["only one"], used_tokens: 5, compaction: completed }
    `)}`,
    message:
      'turns[1].when[0].response.body is a list of 1 — a fold served by more than one request needs at least two summaries; write the single string form for one',
  },
  {
    rule: "a fold's list summary is a non-empty string",
    yaml: `name: x\n${dedent(`
      turns:
        - prompt: a
          when:
            - request: model
              response: ok
        - compact: true
          when:
            - request: { type: model, purpose: compaction }
              response: { body: ["one", ""], used_tokens: 5, compaction: completed }
    `)}`,
    message: 'turns[1].when[0].response.body[1] must be a non-empty string',
  },
  {
    rule: 'no summary of a fold may equal or contain another',
    yaml: `name: x\n${dedent(`
      turns:
        - prompt: a
          when:
            - request: model
              response: ok
        - compact: true
          when:
            - request: { type: model, purpose: compaction }
              response: { body: ["ab", "xab y"], used_tokens: 5, compaction: completed }
    `)}`,
    message:
      'turns[1].when[0].response.body[0] and [1] are not distinct — no summary may equal or contain another, since the request after the fold must be shown to carry each on its own',
  },
  {
    rule: '"one_of" needs at least two variants',
    yaml: turnsKoan(`
      - prompt: a
        one_of:
          only-one:
            - request: model
              response: ok
    `),
    message: 'turns[0].one_of needs at least two variants — use "when" for a single trace',
  },
  {
    rule: 'a turn carries either "when" or "one_of", not both',
    yaml: turnsKoan(`
      - prompt: a
        when:
          - request: model
            response: ok
        one_of:
          x:
            - request: model
              response: ok
          y:
            - request: model
              response: ok2
    `),
    message: 'turns[0] carries both "when" and "one_of" — a turn\'s own trace is one or the other',
  },
  {
    rule: 'a koan writes "one_of" on at most one turn',
    yaml: `name: x\n${dedent(`
      turns:
        - prompt: a
          one_of:
            x:
              - request: model
                response: ok
            y:
              - request: model
                response: ok2
        - prompt: b
          one_of:
            p:
              - request: model
                response: done
            q:
              - request: model
                response: done2
    `)}`,
    message: 'turns[1].one_of: a koan may write "one_of" on at most one turn — turns[0] already does',
  },
  {
    rule: "an ask's one_of variant brings about a fold and nothing else",
    yaml: `name: x\n${dedent(`
      turns:
        - prompt: a
          when:
            - request: model
              response: ok
        - compact: true
          one_of:
            bad:
              - request: model
                response: ok2
            good:
              - request: { type: model, purpose: compaction }
                response: { body: "so far", used_tokens: 5, compaction: completed }
    `)}`,
    message:
      'turns[1].one_of.bad scripts 1 step(s) — an ask brings about the fold and nothing else, since without a prompt there is no other work',
  },
  {
    rule: "a fold's every request counts against the model-request budget",
    yaml: `name: x\n${dedent(`
      given:
        limits:
          run:
            model_requests: 2
      turns:
        - prompt: a
          when:
            - request: model
              response: ok
        - compact: true
          when:
            - request: { type: model, purpose: compaction }
              response: { body: ["one", "two"], used_tokens: 5, compaction: completed }
    `)}`,
    message: 'turns scripts 3 model requests, more than given.limits.run.model_requests (2) permits',
  },
  {
    rule: 'a tool request carries only "tool" and "args"',
    yaml: koan(`
      given:
        files:
          report.md: content
      when:
        - request: model
          response: { tool: read_file, args: { path: report.md } }
        - request: { tool: read_file, arg: { path: report.md } }
        - request: model
          response: done
    `),
    message: 'when[1].request has unknown key "arg" — a tool request carries only "tool" and "args"',
  },
  {
    rule: 'an internal request follows the instruction it executes',
    yaml: koan(`
      given:
        files:
          report.md: content
      when:
        - request: { tool: read_file }
        - request: model
          response: done
    `),
    message: 'when[0]: a request with no response is the agent executing a call itself — it must follow a model response containing a tool-call instruction',
  },
  {
    rule: 'an internal request names a call of the group',
    yaml: koan(`
      given:
        files:
          report.md: content
      when:
        - request: model
          response: { tool: read_file, args: { path: report.md } }
        - request: { tool: read_notes }
        - request: model
          response: done
    `),
    message: 'when[1].request.tool is "read_notes" but the preceding model response requests "read_file"',
  },
  {
    rule: "a declared tool's request carries its response",
    yaml: koan(`
      given:
        files:
          report.md: content
        tools:
          read_file:
            input_schema: { type: object }
      when:
        - request: model
          response: { tool: read_file, args: { path: report.md } }
        - request: { tool: read_file }
        - request: model
          response: done
    `),
    message: 'when[1]: "read_file" is declared in given.tools — a declared tool runs at the tool server, so its request carries the response it answered with',
  },
  {
    rule: "an internal request reads the run's workspace",
    yaml: koan(`
      when:
        - request: model
          response: { tool: read_file, args: { path: report.md } }
        - request: { tool: read_file }
        - request: model
          response: done
    `),
    message: "when[1]: an internal request is the agent reading the run's workspace — the call's args.path must name a given.files entry",
  },
  {
    rule: 'a call that names a workspace file cannot be left to an absence',
    yaml: koan(`
      given:
        files:
          report.md: content
      when:
        - request: model
          response: { tool: read_file, args: { path: report.md } }
        - request: model
          response: done
    `),
    message: 'when[1]: the call to "read_file" names given.files["report.md"] but no step says what became of it — a request with no response, "- request: { tool: read_file }", says the agent executed it itself',
  },
  {
    rule: 'a trace fits the model-request budget',
    yaml: koan(`
      given:
        limits:
          run:
            model_requests: 1
      when:
        - request: model
          response: { tool: x, args: {} }
        - request: { tool: x }
          response: { status: 200 }
        - request: model
          response: done
    `),
    message: 'when scripts 2 model requests, more than given.limits.run.model_requests (1) permits',
  },
];

it.each(rows)('rejects: $rule', ({ yaml, message }) => {
  const result = parseKoanFile(parseYaml(yaml));
  expect(isProblem(result) ? result.message : undefined).toBe(message);
});
