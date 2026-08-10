// What the koan file format promises: a corpus of invalid shapes, each
// rejected with the exact message src/format.ts documents, and every
// koan actually bundled with this suite accepted. Runtime behavior (what
// a passing/failing run looks like) belongs to conformance.test.ts and
// cli.test.ts, not here — this file only checks the load-time contract.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';
import { parseKoanFile } from '../src/format.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const weatherTool = { get_weather: { input_schema: { type: 'object', properties: { city: { type: 'string' } } } } };

describe('parseKoanFile: bundled koans', () => {
  const dir = path.join(repoRoot, 'koans');
  for (const name of fs.readdirSync(dir).sort()) {
    if (!name.endsWith('.yaml')) continue;
    it(`${name} is a valid koan file`, () => {
      const raw = parse(fs.readFileSync(path.join(dir, name), 'utf8'));
      const result = parseKoanFile(raw);
      expect(typeof result === 'string' ? result : undefined).toBeUndefined();
    });
  }
});

describe('parseKoanFile: invalid shapes', () => {
  it('rejects a non-mapping file', () => {
    expect(parseKoanFile(['not', 'a', 'mapping'])).toBe('not a YAML mapping');
  });

  it('rejects a file with no "name"', () => {
    expect(parseKoanFile({})).toBe('missing "name"');
  });

  it('rejects the removed "given.task" field', () => {
    const result = parseKoanFile({
      name: 'x',
      given: { task: 'do the thing' },
      prompt: 'p',
      when: [{ request: 'model', response: 'ok' }],
    });
    expect(result).toBe('"given.task" was replaced by a top-level "prompt" field');
  });

  it('rejects "given.tools" that is not a mapping', () => {
    const result = parseKoanFile({ name: 'x', given: { tools: 'nope' }, prompt: 'p', when: [{ request: 'model', response: 'ok' }] });
    expect(result).toBe('"given.tools" must be a mapping of tool name to definition');
  });

  it('rejects "given.limits" with no "max_model_requests"', () => {
    const result = parseKoanFile({ name: 'x', given: { limits: {} }, prompt: 'p', when: [{ request: 'model', response: 'ok' }] });
    expect(result).toBe('"given.limits.max_model_requests" must be a positive integer');
  });

  it('rejects a koan with both "when" and "one_of"', () => {
    const result = parseKoanFile({
      name: 'x',
      prompt: 'p',
      when: [{ request: 'model', response: 'ok' }],
      one_of: { a: [{ request: 'model', response: 'ok' }], b: [{ request: 'model', response: 'no' }] },
    });
    expect(result).toBe('a koan needs exactly one of "when" / "one_of" / "turns"');
  });

  it('rejects "turns" combined with a top-level "prompt"', () => {
    const result = parseKoanFile({
      name: 'x',
      prompt: 'p',
      turns: [
        { prompt: 'a', when: [{ request: 'model', response: 'ok' }] },
        { prompt: 'b', when: [{ request: 'model', response: 'ok' }] },
      ],
    });
    expect(result).toBe('"prompt" cannot be combined with "turns" — the first turn\'s prompt is the initial one');
  });

  it('rejects a missing "prompt" on a "when" koan', () => {
    const result = parseKoanFile({ name: 'x', when: [{ request: 'model', response: 'ok' }] });
    expect(result).toBe('missing "prompt"');
  });

  it('rejects an all-whitespace "prompt"', () => {
    const result = parseKoanFile({ name: 'x', prompt: '   ', when: [{ request: 'model', response: 'ok' }] });
    expect(result).toBe('"prompt" must be non-empty');
  });

  it('rejects "turns" with fewer than two entries', () => {
    const result = parseKoanFile({ name: 'x', turns: [{ prompt: 'a', when: [{ request: 'model', response: 'ok' }] }] });
    expect(result).toBe('"turns" needs at least two entries — a 1-turn koan is just "when"');
  });

  it('rejects "one_of" with fewer than two variants', () => {
    const result = parseKoanFile({ name: 'x', prompt: 'p', one_of: { a: [{ request: 'model', response: 'ok' }] } });
    expect(result).toBe('"one_of" needs at least two variants — use "when" for a single trace');
  });

  it('rejects a bare "abort" with nothing before it', () => {
    const result = parseKoanFile({ name: 'x', prompt: 'p', when: ['abort'] });
    expect(result).toBe('when[0]: "abort" needs at least one exchange before it in the trace');
  });

  it('rejects a step after "abort"', () => {
    const result = parseKoanFile({
      name: 'x',
      prompt: 'p',
      when: [{ request: 'model', response: 'ok' }, 'abort', { request: 'model', response: 'again' }],
    });
    expect(result).toBe('when[2]: nothing can follow "abort" — it must be the trace\'s last step');
  });

  it('rejects a 1-element parallel group', () => {
    const result = parseKoanFile({
      name: 'x',
      given: { tools: weatherTool },
      prompt: 'p',
      when: [{ request: 'model', response: [{ tool: 'get_weather', args: { city: 'Tokyo' } }] }],
    });
    expect(result).toBe(
      'when[0].response is a list of 1 — a parallel group needs at least two instructions; write the single "{ tool, args }" form instead',
    );
  });

  it('rejects duplicate members in a parallel group', () => {
    const result = parseKoanFile({
      name: 'x',
      given: { tools: weatherTool },
      prompt: 'p',
      when: [
        {
          request: 'model',
          response: [
            { tool: 'get_weather', args: { city: 'Tokyo' } },
            { tool: 'get_weather', args: { city: 'Tokyo' } },
          ],
        },
      ],
    });
    expect(result).toBe(
      'when[0]: list members [0] and [1] both call "get_weather" with the same arguments — matching a following tool request against them would be ambiguous',
    );
  });

  it('rejects a tool request following malformed (unparseable) arguments', () => {
    const result = parseKoanFile({
      name: 'x',
      given: { tools: weatherTool },
      prompt: 'p',
      when: [
        { request: 'model', response: { tool: 'get_weather', args: '{"city": "Tok' } },
        { request: { tool: 'get_weather' }, response: { status: 200, body: {} } },
      ],
    });
    expect(result).toBe(
      'when[1]: "get_weather"\'s arguments do not parse as a JSON object — argument fidelity is undefined, so the agent must refuse the call instead (R6); no tool request can follow it',
    );
  });

  it('rejects a step after a model API failure', () => {
    const result = parseKoanFile({
      name: 'x',
      prompt: 'p',
      when: [{ request: 'model', response: { status: 401 } }, { request: 'model', response: 'too late' }],
    });
    expect(result).toBe('when[1]: nothing can follow a model API failure — the agent must stop (R8)');
  });

  it('rejects a model API failure with a retryable status', () => {
    const result = parseKoanFile({ name: 'x', prompt: 'p', when: [{ request: 'model', response: { status: 429 } }] });
    expect(result).toBe('when[0].response.status must be a non-retryable 4xx (not 408/429) for a model API failure');
  });

  it('rejects a trace that exceeds the model-request budget', () => {
    const result = parseKoanFile({
      name: 'x',
      given: { tools: weatherTool, limits: { max_model_requests: 1 } },
      prompt: 'p',
      when: [
        { request: 'model', response: { tool: 'get_weather', args: { city: 'Tokyo' } } },
        { request: { tool: 'get_weather' }, response: { status: 200, body: { temp: 31 } } },
        { request: 'model', response: 'done' },
      ],
    });
    expect(result).toBe('when scripts 2 model requests, more than given.limits.max_model_requests (1) permits');
  });

  it('rejects a briefing that is not distinct from the prompt', () => {
    const result = parseKoanFile({
      name: 'x',
      prompt: 'Look things up.',
      when: [
        { request: 'model', response: { subagent: 'researcher', prompt: 'Look things up.' } },
        { subagent: 'researcher', when: [{ request: 'model', response: 'done' }] },
        { request: 'model', response: 'ok' },
      ],
    });
    expect(result).toBe(
      'when: prompt and the briefing of subagent "researcher" are not distinct — no briefing may equal or contain another briefing or the prompt, since requests are attributed to conversations by their opening',
    );
  });

  it('rejects a subagent name delegated to twice in one trace', () => {
    const result = parseKoanFile({
      name: 'x',
      prompt: 'Do two things.',
      when: [
        { request: 'model', response: { subagent: 'researcher', prompt: 'First briefing.' } },
        { subagent: 'researcher', when: [{ request: 'model', response: 'first done' }] },
        { request: 'model', response: { subagent: 'researcher', prompt: 'Second briefing.' } },
        { subagent: 'researcher', when: [{ request: 'model', response: 'second done' }] },
        { request: 'model', response: 'ok' },
      ],
    });
    expect(result).toBe(
      'when[3]: subagent "researcher" already has a conversation in this trace — a subagent conversation cannot be continued yet',
    );
  });
});
