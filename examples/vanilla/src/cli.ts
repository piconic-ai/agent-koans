// Terminal adapter: the same agent server.ts exposes over HTTP, driven by
// one prompt and polled to its answer. What belongs here is reading
// arguments and printing a result; what does not is any part of the agent
// — this file only submits a run and waits.
import { readFile } from 'node:fs/promises';
import { createAgent } from './agent.js';
import { loadConfig } from './config.js';
import type { RunSetup } from './run.js';

const USAGE = `Usage: cli [options] "<prompt>"

Options:
  --system <text>     standing instructions for the conversation
  --setup <file>      JSON with tools, subagents, limits and context
  --workspace <dir>   directory read_file resolves against  [default: the working directory]
  --tools-url <url>   service a declared tool is invoked on
  -h, --help          show this help

Environment:
  OPENAI_API_KEY, OPENAI_BASE_URL, OPENAI_MODEL
`;

interface Args {
  prompt: string;
  system?: string;
  setup?: string;
  workspace?: string;
  toolsUrl?: string;
}

function parseArgs(argv: string[]): Args {
  const args: Partial<Args> = {};
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    const value = (): string => {
      const next = argv[(i += 1)];
      if (next === undefined) fail(`${flag} needs a value`);
      return next;
    };
    if (flag === '-h' || flag === '--help') {
      process.stdout.write(USAGE);
      process.exit(0);
    } else if (flag === '--system') args.system = value();
    else if (flag === '--setup') args.setup = value();
    else if (flag === '--workspace') args.workspace = value();
    else if (flag === '--tools-url') args.toolsUrl = value();
    else if (flag.startsWith('-')) fail(`unknown option ${flag}`);
    else if (args.prompt === undefined) args.prompt = flag;
    else fail('more than one prompt given');
  }
  if (args.prompt === undefined) fail('a prompt is required');
  return args as Args;
}

function fail(message: string): never {
  process.stderr.write(`cli: ${message}\n\n${USAGE}`);
  process.exit(2);
}

const args = parseArgs(process.argv.slice(2));
const config = loadConfig();
const agent = createAgent({
  model: config.model,
  tools: { baseUrl: args.toolsUrl ?? config.tools.baseUrl },
  workspace: { dir: args.workspace ?? config.workspace.dir },
});

const declared = args.setup === undefined ? {} : (JSON.parse(await readFile(args.setup, 'utf8')) as Partial<RunSetup>);
const state = agent.startRun(args.prompt, {
  tools: declared.tools ?? [],
  subagents: declared.subagents ?? [],
  limits: declared.limits,
  context: declared.context,
  system: args.system,
});

// Polled, not awaited: a run is asynchronous to whoever submitted it, and
// this adapter is a client of the same agent every other one talks to.
while (state.status === 'running') {
  await new Promise((resolve) => setTimeout(resolve, 50));
}

// A fold rewrites the conversation, so a client that hides one cannot say
// why an answer stopped knowing something it was told earlier.
for (const event of state.events) {
  process.stderr.write(`[${event.type} ${event.phase}]${event.error === undefined ? '' : ` ${event.error}`}\n`);
}

if (state.status !== 'completed') {
  process.stderr.write(`cli: run ${state.status}: ${state.error ?? 'no reason given'}\n`);
  process.exit(1);
}
process.stdout.write(`${state.output ?? ''}\n`);
