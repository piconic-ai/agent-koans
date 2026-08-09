// Renders the --help screen: a one-line tool description, then Usage /
// Options / Examples sections with two-column option alignment and
// restrained ANSI styling (bold headings, dim descriptions). Deciding
// *whether* to colorize (TTY check, NO_COLOR) is the caller's job, not
// this module's: --help prints to stdout but a usage error reprints the
// same screen to stderr, and the two streams can disagree on TTY-ness.
// The run-output format (ok/FAIL/skip lines, tallies) is a separate
// concern and does not live here.

// Kept as a literal rather than imported from package.json: importing
// JSON from src/ crosses tsconfig.build.json's rootDir (src/) out to the
// repo root, which the build rejects.
const DESCRIPTION = 'framework-agnostic conformance suite for AI agent implementations';

interface Style {
  bold: (s: string) => string;
  dim: (s: string) => string;
}

function style(enabled: boolean): Style {
  const wrap = (code: string) => (s: string) => (enabled ? `\x1b[${code}m${s}\x1b[0m` : s);
  return { bold: wrap('1'), dim: wrap('2') };
}

interface Option {
  flag: string;
  /** One entry per line; lines after the first are continuations, indented under the description column. */
  desc: string[];
  /** Set when the flag is mandatory; renders a trailing `[required]` annotation. */
  required?: true;
  /**
   * Default behavior when the flag is omitted; renders a trailing
   * `[default: <defaultNote>]` annotation. Kept out of `desc` so the
   * fact lives in exactly one, uniformly styled place instead of as
   * free-form parenthetical prose.
   */
  defaultNote?: string;
}

// Flags only cover how THIS invocation runs; what the suite consists of
// (skip, add) is agent-koans.yaml's job (config.ts) and has no CLI
// equivalent, so it is not listed here.
const OPTIONS: Option[] = [
  { flag: '--agent <command>', desc: ['shell command that starts your agent'], required: true },
  { flag: '--cwd <dir>', desc: ['working directory for the agent command'] },
  { flag: '--koans <dir>', desc: ['koans directory'], defaultNote: './koans, else the bundled copy' },
  { flag: '--filter <text>', desc: ['run only koans whose id contains <text>'] },
  { flag: '--config <file>', desc: ['config file'], defaultNote: './agent-koans.yaml if present' },
  { flag: '-h, --help', desc: ['show this help'] },
];

const EXAMPLES = [
  'agent-koans --agent "node dist/server.js"',
  'agent-koans --agent "node dist/server.js" --filter arg-validation',
  'agent-koans --agent "node dist/server.js" --config ./ci/agent-koans.yaml',
];

// `required` and `defaultNote` render as one bracketed annotation, styled
// distinctly from the description (bold vs. dim) so required-ness and
// defaults stay scannable instead of blending into prose.
function annotation(opt: Option, s: Style): string {
  if (opt.required) return s.bold('[required]');
  if (opt.defaultNote !== undefined) return s.dim(`[default: ${opt.defaultNote}]`);
  return '';
}

/** Render the full --help screen. `color` toggles ANSI styling; pass the target stream's TTY-ness. */
export function renderHelp(color: boolean): string {
  const s = style(color);
  const flagWidth = Math.max(...OPTIONS.map((o) => o.flag.length));
  const gutter = ' '.repeat(flagWidth + 4); // 2-space indent + flag column + 2-space gap

  const options = OPTIONS.map((opt) => {
    const lines = opt.desc.map((line, i) =>
      i === 0 ? `  ${s.bold(opt.flag.padEnd(flagWidth))}  ${s.dim(line)}` : `${gutter}${s.dim(line)}`,
    );
    const note = annotation(opt, s);
    if (note) lines[lines.length - 1] += `  ${note}`;
    return lines.join('\n');
  }).join('\n');

  const examples = EXAMPLES.map((cmd) => `  ${cmd}`).join('\n');

  return [
    `agent-koans — ${DESCRIPTION}`,
    '',
    s.bold('Usage'),
    '  agent-koans --agent "<command>" [options]',
    '',
    s.bold('Options'),
    options,
    '',
    s.bold('Examples'),
    examples,
  ].join('\n');
}
