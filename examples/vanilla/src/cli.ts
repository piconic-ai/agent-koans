// Terminal adapter: the same assistant server.ts exposes over HTTP, asked
// from a shell. One prompt and an answer, or no prompt and a conversation.
// What belongs here is reading arguments, waiting, and printing; what does
// not is any part of the agent — this file only submits and polls.
import { readFile } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { createAgent, type RunSetup } from './agent/index.js';
import { assistant } from './assistant.js';
import { loadConfig } from './config.js';

const USAGE = `Usage: cli [options] [prompt]

With no prompt, reads them one per line and keeps the conversation going.

Options:
  --setup <file>      JSON with tools, subagents, limits and context
  --workspace <dir>   directory read_file resolves against  [default: the working directory]
  --tools-url <url>   service a declared tool is invoked on
  -h, --help          show this help

Environment:
  OPENAI_API_KEY, OPENAI_BASE_URL, OPENAI_MODEL
`;

interface Args {
  prompt?: string;
  setup?: string;
  workspace?: string;
  toolsUrl?: string;
}

function parseArgs(argv: string[]): Args {
  const args: Args = {};
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
    } else if (flag === '--setup') args.setup = value();
    else if (flag === '--workspace') args.workspace = value();
    else if (flag === '--tools-url') args.toolsUrl = value();
    else if (flag.startsWith('-')) fail(`unknown option ${flag}`);
    else if (args.prompt === undefined) args.prompt = flag;
    else fail('more than one prompt given');
  }
  return args;
}

function fail(message: string): never {
  process.stderr.write(`cli: ${message}\n\n${USAGE}`);
  process.exit(2);
}

const args = parseArgs(process.argv.slice(2));
const config = loadConfig();
if (args.workspace !== undefined) config.workspace.dir = args.workspace;
if (args.toolsUrl !== undefined) config.tools.baseUrl = args.toolsUrl;

const agent = createAgent(assistant(config), config);
const declared = args.setup === undefined ? {} : (JSON.parse(await readFile(args.setup, 'utf8')) as Partial<RunSetup>);
const setup: RunSetup = {
  tools: declared.tools ?? [],
  subagents: declared.subagents ?? [],
  limits: declared.limits,
  context: declared.context,
};

type RunState = NonNullable<ReturnType<typeof agent.getRun>>;

// Polled, not awaited: a run is asynchronous to whoever submitted it, and
// this adapter is a client of the agent like any other.
async function settled(state: RunState): Promise<RunState> {
  while (state.status === 'running') {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return state;
}

// A fold rewrites the conversation, so a client that hides one cannot say
// why an answer stopped knowing something it was told earlier.
function report(state: RunState, from: number): number {
  for (const event of state.events.slice(from)) {
    process.stderr.write(`[${event.type} ${event.phase}]${event.error === undefined ? '' : ` ${event.error}`}\n`);
  }
  return state.events.length;
}

if (args.prompt !== undefined) {
  const state = await settled(agent.startRun(args.prompt, setup));
  report(state, 0);
  if (state.status !== 'completed') {
    process.stderr.write(`cli: run ${state.status}: ${state.error ?? 'no reason given'}\n`);
    process.exit(1);
  }
  process.stdout.write(`${state.output ?? ''}\n`);
} else {
  // One run for the whole session: a second line is a follow-up prompt, so
  // the assistant answers it knowing what was already said.
  const lines = createInterface({ input: process.stdin, output: process.stdout, prompt: '> ' });
  let state: RunState | undefined;
  let reported = 0;
  lines.prompt();
  for await (const line of lines) {
    if (line.trim() !== '') {
      if (state === undefined) state = agent.startRun(line, setup);
      else agent.sendPrompt(state.run_id, line);
      await settled(state);
      reported = report(state, reported);
      process.stdout.write(
        state.status === 'completed'
          ? `${state.output ?? ''}\n`
          : `cli: run ${state.status}: ${state.error ?? 'no reason given'}\n`,
      );
    }
    lines.prompt();
  }
}
