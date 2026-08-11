// Internal: renders the suite's index — every koan's id and the contract
// line its description states — for the block SPEC.md carries between its
// koan-index markers. Nothing here is part of the runner: the index exists
// so a reader sees the whole contract in one page, and so that page cannot
// drift from the koans, since a test regenerates it and compares.
//
// The koans are the contract. This module never paraphrases one: a koan's
// own `description` is what appears, whitespace collapsed and nothing else
// changed. Rewording belongs in the koan file.
import fs from 'node:fs';
import path from 'node:path';
import { parse } from 'yaml';

export const INDEX_START = '<!-- koan-index:start -->';
export const INDEX_END = '<!-- koan-index:end -->';

/** One line of the index, in file order. */
function renderEntry(dir: string, file: string): string {
  const raw = parse(fs.readFileSync(path.join(dir, file), 'utf8')) as {
    name?: unknown;
    description?: unknown;
  };
  const id = file.replace(/\.ya?ml$/, '');
  if (typeof raw?.description !== 'string' || raw.description.trim() === '') {
    throw new Error(`koan ${file} has no description to index`);
  }
  const line = raw.description.split(/\s+/).filter(Boolean).join(' ');
  return `- **[${id}](./koans/${file})** — ${line}`;
}

/** The whole index block, markers included, as SPEC.md should carry it. */
export function renderKoanIndex(koansDir: string): string {
  const files = fs
    .readdirSync(koansDir)
    .filter((f) => f.endsWith('.yaml') || f.endsWith('.yml'))
    .sort();
  const entries = files.map((f) => renderEntry(koansDir, f));
  return [INDEX_START, '', ...entries, '', INDEX_END].join('\n');
}

/** Replace the marked block in `spec` with a freshly rendered one. */
export function withKoanIndex(spec: string, koansDir: string): string {
  const start = spec.indexOf(INDEX_START);
  const end = spec.indexOf(INDEX_END);
  if (start === -1 || end === -1) {
    throw new Error(`SPEC.md is missing its ${INDEX_START} / ${INDEX_END} markers`);
  }
  return spec.slice(0, start) + renderKoanIndex(koansDir) + spec.slice(end + INDEX_END.length);
}
