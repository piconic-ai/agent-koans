// What the CLI promises: --help documents itself, usage errors exit 2,
// a passing suite exits 0 with per-koan lines, a failing koan exits 1.
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const tsx = path.join(repoRoot, 'runner/node_modules/.bin/tsx');
const cli = path.join(repoRoot, 'runner/src/cli.ts');
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

describe('cli', () => {
  it('prints usage on --help', async () => {
    const { code, stdout } = await runCli(['--help']);
    expect(code).toBe(0);
    expect(stdout).toContain('Usage: agent-koans');
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
      const source = path.join(repoRoot, 'koans/lifecycle/000-plain-completion.yaml');
      const broken = fs
        .readFileSync(source, 'utf8')
        .replace(/output: .*/, 'output: { contains: "never-the-output" }');
      expect(broken).toContain('never-the-output');
      fs.writeFileSync(path.join(chapter, '000-broken.yaml'), broken);

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
