// Renders the suite's index — every koan's id and the contract line its
// description states — for the table SPEC.md carries between its
// koan-index markers. A repository tool, not part of the runner and not
// published: it lives here so nothing that maintains the docs ships to
// anyone installing the package.
//
// The koans are the contract. This module never paraphrases one: a koan's
// own `description` is what appears, whitespace collapsed and nothing else
// changed. Rewording belongs in the koan file.
import fs from 'node:fs';
import path from 'node:path';
import { parse } from 'yaml';

export const INDEX_START = '<!-- koan-index:start -->';
export const INDEX_END = '<!-- koan-index:end -->';

/** One row of the index table, in file order. */
function renderEntry(dir: string, file: string): string {
  const raw = parse(fs.readFileSync(path.join(dir, file), 'utf8')) as {
    name?: unknown;
    description?: unknown;
  };
  const id = file.replace(/\.ya?ml$/, '');
  if (typeof raw?.description !== 'string' || raw.description.trim() === '') {
    throw new Error(`koan ${file} has no description to index`);
  }
  // A cell cannot carry a line break, and a description written as a YAML
  // folded block arrives with them.
  const line = raw.description.split(/\s+/).filter(Boolean).join(' ');
  return `| [${id}](./koans/${file}) | ${line} |`;
}

/** The whole index block, markers included, as SPEC.md should carry it. */
export function renderKoanIndex(koansDir: string): string {
  const files = fs
    .readdirSync(koansDir)
    .filter((f) => f.endsWith('.yaml') || f.endsWith('.yml'))
    .sort();
  const rows = files.map((f) => renderEntry(koansDir, f));
  return [INDEX_START, '', '| Koan | Contract |', '| ---- | -------- |', ...rows, '', INDEX_END].join('\n');
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
