// What the CLI promises: --help documents itself, usage errors exit 2,
// a passing suite exits 0 with per-koan lines, a failing koan exits 1.
// Also covers agent-koans.yaml (custom koans via `add`, skip with
// mandatory reasons): the config-loading rules themselves live in
// config.ts, this file only checks the CLI wires them in correctly.
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tsx = path.join(repoRoot, 'node_modules/.bin/tsx');
const cli = path.join(repoRoot, 'src/cli.ts');
const vanillaAgent = ['--agent', 'pnpm --silent start', '--cwd', path.join(repoRoot, 'examples/vanilla-ts')];

interface CliResult {
  code: number;
  stdout: string;
  stderr: string;
}

function runCli(args: string[], cwd: string = repoRoot): Promise<CliResult> {
  return new Promise((resolve, reject) => {
    execFile(tsx, [cli, ...args], { cwd, timeout: 120_000 }, (error, stdout, stderr) => {
      if (error && typeof error.code !== 'number') return reject(error);
      resolve({ code: error ? (error.code as number) : 0, stdout, stderr });
    });
  });
}

/** A koan file that always passes: a verbatim copy of the plain-completion koan. */
function passingKoanYaml(): string {
  return fs.readFileSync(path.join(repoRoot, 'koans/lifecycle/000-plain-completion.yaml'), 'utf8');
}

/** A koan file that always fails: the plain-completion koan with an unreachable expected output. */
function brokenKoanYaml(): string {
  return passingKoanYaml().replace(/output: .*/, 'output: { contains: "never-the-output" }');
}

describe('cli', () => {
  it('prints usage on --help', async () => {
    const { code, stdout } = await runCli(['--help']);
    expect(code).toBe(0);
    expect(stdout).toContain('agent-koans —');
    expect(stdout).toContain('Usage');
    expect(stdout).toContain('agent-koans --agent "<command>" [options]');
    expect(stdout).toContain('Options');
    expect(stdout).toContain('--config <file>');
    expect(stdout).toContain('Examples');
    expect(stdout).not.toContain('--add-koans');
    expect(stdout).not.toContain('--skip-koans');
    // Required-ness and defaults are annotations, not prose: [required] on
    // --agent, and at least one [default: ...] (--koans and --config).
    expect(stdout).toContain('--agent <command>  shell command that starts your agent  [required]');
    expect(stdout).toContain('[default:');
  });

  it('--help is not colorized when stdout is piped (not a TTY)', async () => {
    const { stdout } = await runCli(['--help']);
    expect(stdout.includes(String.fromCharCode(27))).toBe(false);
  });

  it('exits 2 without --agent', async () => {
    const { code, stderr } = await runCli([]);
    expect(code).toBe(2);
    expect(stderr).toContain('--agent is required');
  });

  it('exits 2 when no koan matches the filter', async () => {
    const { code, stderr } = await runCli([...vanillaAgent, '--filter', 'no-such-koan']);
    expect(code).toBe(2);
    expect(stderr).toContain('no koan id contains');
  });

  it('runs a koan against an agent and exits 0', { timeout: 120_000 }, async () => {
    const { code, stdout } = await runCli([...vanillaAgent, '--filter', 'lifecycle/000']);
    expect(code).toBe(0);
    expect(stdout).toContain('ok    lifecycle/000-plain-completion');
    expect(stdout).toContain('1/1 passed');
  });

  it('exits 1 when a koan fails', { timeout: 120_000 }, async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-koans-cli-'));
    try {
      const chapter = path.join(dir, 'chapter');
      fs.mkdirSync(chapter);
      fs.writeFileSync(path.join(chapter, '000-broken.yaml'), brokenKoanYaml());

      const { code, stdout, stderr } = await runCli([...vanillaAgent, '--koans', dir]);
      expect(code).toBe(1);
      expect(stderr).toContain('FAIL  chapter/000-broken');
      expect(stdout).toContain('0/1 passed');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('exits 2 when --koans is not a directory', async () => {
    const { code, stderr } = await runCli([...vanillaAgent, '--koans', 'README.md']);
    expect(code).toBe(2);
    expect(stderr).toContain('koans directory not found');
  });
});

describe('cli custom koans and config', () => {
  it('auto-discovers agent-koans.yaml in the current directory and runs its added koans', { timeout: 120_000 }, async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-koans-autoconfig-'));
    try {
      const chapter = path.join(dir, 'my-koans', 'chapter');
      fs.mkdirSync(chapter, { recursive: true });
      fs.writeFileSync(path.join(chapter, '001-hello.yaml'), passingKoanYaml());
      fs.writeFileSync(path.join(dir, 'agent-koans.yaml'), 'add:\n  - ./my-koans\n');

      const { code, stdout } = await runCli([...vanillaAgent, '--filter', 'hello'], dir);
      expect(code).toBe(0);
      expect(stdout).toContain('my-koans:');
      expect(stdout).toContain('ok    my-koans/chapter/001-hello');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('exits 2 when --config file does not exist', async () => {
    const { code, stderr } = await runCli([...vanillaAgent, '--config', 'no-such-config.yaml']);
    expect(code).toBe(2);
    expect(stderr).toContain('config file not found');
  });

  it(
    '--config skip reports the reason and does not fail the suite, even when the skipped koan would fail',
    { timeout: 120_000 },
    async () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-koans-skip-'));
      try {
        const chapter = path.join(dir, 'my-koans', 'chapter');
        fs.mkdirSync(chapter, { recursive: true });
        fs.writeFileSync(path.join(chapter, '000-broken.yaml'), brokenKoanYaml());
        fs.writeFileSync(path.join(chapter, '001-hello.yaml'), passingKoanYaml());
        const config = path.join(dir, 'my-config.yaml');
        fs.writeFileSync(
          config,
          'add:\n  - ./my-koans\nskip:\n  my-koans/chapter/000-broken: "known broken, tracked in #123"\n',
        );

        const { code, stdout } = await runCli(
          [...vanillaAgent, '--config', config, '--filter', 'my-koans'],
          dir,
        );
        expect(code).toBe(0);
        expect(stdout).toContain('skip  my-koans/chapter/000-broken');
        expect(stdout).toContain('known broken, tracked in #123');
        expect(stdout).toContain('ok    my-koans/chapter/001-hello');
        expect(stdout).toContain('1/2 passed, 1 skipped');
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    },
  );

  it('errors when skip is a bare list instead of id -> reason', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-koans-skip-list-'));
    try {
      fs.writeFileSync(path.join(dir, 'agent-koans.yaml'), 'skip:\n  - lifecycle/000-plain-completion\n');
      const { code, stderr } = await runCli([...vanillaAgent], dir);
      expect(code).toBe(2);
      expect(stderr).toContain('reason');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('errors when a skip entry has an empty reason', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-koans-skip-empty-'));
    try {
      fs.writeFileSync(path.join(dir, 'agent-koans.yaml'), 'skip:\n  lifecycle/000-plain-completion: ""\n');
      const { code, stderr } = await runCli([...vanillaAgent], dir);
      expect(code).toBe(2);
      expect(stderr).toContain('reason');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('errors when a skip entry matches no discovered koan', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-koans-skip-stale-'));
    try {
      fs.writeFileSync(
        path.join(dir, 'agent-koans.yaml'),
        'skip:\n  nope/999-does-not-exist: "no longer applies"\n',
      );
      const { code, stderr } = await runCli([...vanillaAgent], dir);
      expect(code).toBe(2);
      expect(stderr).toContain('nope/999-does-not-exist');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('errors on an unknown config key', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-koans-unknown-key-'));
    try {
      fs.writeFileSync(path.join(dir, 'agent-koans.yaml'), 'agent:\n  command: "node server.js"\n');
      const { code, stderr } = await runCli([...vanillaAgent], dir);
      expect(code).toBe(2);
      expect(stderr).toContain('unknown key "agent"');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('errors when two added directories share a basename', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-koans-dup-basename-'));
    try {
      const chapterA = path.join(dir, 'a', 'my-koans', 'chapter');
      const chapterB = path.join(dir, 'b', 'my-koans', 'chapter');
      fs.mkdirSync(chapterA, { recursive: true });
      fs.mkdirSync(chapterB, { recursive: true });
      fs.writeFileSync(path.join(chapterA, '001-hello.yaml'), passingKoanYaml());
      fs.writeFileSync(path.join(chapterB, '001-hello.yaml'), passingKoanYaml());
      fs.writeFileSync(path.join(dir, 'agent-koans.yaml'), 'add:\n  - ./a/my-koans\n  - ./b/my-koans\n');

      const { code, stderr } = await runCli([...vanillaAgent], dir);
      expect(code).toBe(2);
      expect(stderr).toContain('share the basename "my-koans"');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it(
    'skips a bundled koan via config, with no `add` involved',
    { timeout: 120_000 },
    async () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-koans-skip-bundled-'));
      try {
        fs.writeFileSync(
          path.join(dir, 'agent-koans.yaml'),
          'skip:\n  lifecycle/000-plain-completion: "flaky in this environment"\n',
        );

        const { code, stdout } = await runCli([...vanillaAgent, '--filter', 'lifecycle/000'], dir);
        expect(code).toBe(0);
        expect(stdout).toContain('skip  lifecycle/000-plain-completion');
        expect(stdout).toContain('flaky in this environment');
        expect(stdout).toContain('0/1 passed, 1 skipped');
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    },
  );

  it(
    'resolves `add` paths relative to the config file, not the process cwd',
    { timeout: 120_000 },
    async () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-koans-add-relative-'));
      try {
        const chapter = path.join(dir, 'conf', 'my-koans', 'chapter');
        fs.mkdirSync(chapter, { recursive: true });
        fs.writeFileSync(path.join(chapter, '001-hello.yaml'), passingKoanYaml());
        fs.writeFileSync(path.join(dir, 'conf', 'config.yaml'), 'add:\n  - ./my-koans\n');

        // cwd is <dir>, not <dir>/conf, and <dir> has no my-koans of its
        // own: "./my-koans" only resolves if `add` is resolved against the
        // config file's own directory rather than the process cwd.
        const { code, stdout } = await runCli(
          [...vanillaAgent, '--config', 'conf/config.yaml', '--filter', 'hello'],
          dir,
        );
        expect(code).toBe(0);
        expect(stdout).toContain('ok    my-koans/chapter/001-hello');
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    },
  );

  it('errors when an `add` directory does not exist', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-koans-add-missing-'));
    try {
      fs.writeFileSync(path.join(dir, 'agent-koans.yaml'), 'add:\n  - ./no-such-dir\n');
      const { code, stderr } = await runCli([...vanillaAgent], dir);
      expect(code).toBe(2);
      expect(stderr).toContain('add directory not found');
      expect(stderr).not.toContain('--add-koans');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it(
    'a skip stays valid even when --filter excludes the skipped koan',
    { timeout: 120_000 },
    async () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-koans-skip-filtered-out-'));
      try {
        fs.writeFileSync(
          path.join(dir, 'agent-koans.yaml'),
          'skip:\n  lifecycle/000-plain-completion: "not relevant to this run"\n',
        );

        // The stale-skip check runs against the full pre-filter set (by
        // design), so a filter that excludes the skipped koan must not
        // make the skip look stale.
        const { code, stdout, stderr } = await runCli(
          [...vanillaAgent, '--filter', 'tool-reliability/001'],
          dir,
        );
        expect(code).toBe(0);
        expect(stderr).not.toContain('matches no discovered koan');
        expect(stdout).toContain('ok    tool-reliability/001-happy-path');
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    },
  );
});
