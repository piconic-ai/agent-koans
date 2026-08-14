// What the release script promises: it decides for itself whether the
// version main carries is already out, and when it is not, it publishes,
// tags, pushes the tag and creates the GitHub release — in that order,
// with that version's CHANGELOG section as the notes. The workflow runs
// it on every push to main and depends on all of that, so the script is
// exercised here against stub git, npm and gh commands rather than being
// trusted to be obvious. The last case checks the wiring itself: the
// script must run before the changesets action, which must not be given
// a publish input.
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const releaseScript = path.join(repoRoot, '.github/scripts/release.sh');
const releaseWorkflow = path.join(repoRoot, '.github/workflows/release.yml');

const VERSION = '0.8.0';

const CHANGELOG = `# agent-koans

## 0.9.0

### Minor Changes

- the next version's note

## ${VERSION}

### Minor Changes

- the note this release must carry

## 0.7.0

### Minor Changes

- the previous version's note
`;

// One record per call: the command name, then its arguments. NUL between
// the arguments and 0x1e between the calls, because release notes are
// multi-line and a line-based log could not hold them.
const STUB = `#!/usr/bin/env bash
name=\${0##*/}
{ printf '%s\\0' "$name" "$@"; printf '\\036'; } >>"$CALLS"
case "$name" in
  git)
    case "$1" in
      rev-parse) exit "\${TAG_EXISTS_EXIT:-1}" ;;
    esac
    ;;
  npm)
    case "$1" in
      view) exit "\${ON_NPM_EXIT:-1}" ;;
      publish) exit "\${PUBLISH_EXIT:-0}" ;;
    esac
    ;;
esac
exit 0
`;

interface ReleaseRun {
  code: number;
  stdout: string;
  /** One entry per stubbed command call, in the order the script made them. */
  calls: string[][];
}

/** `git rev-parse`, `npm publish`, … — a call named the way an assertion reads. */
function named(calls: string[][]): string[] {
  return calls.map((call) => `${call[0]} ${call[1]}`);
}

/** The notes the script handed `gh release create`, or undefined if it never got there. */
function releaseNotes(calls: string[][]): string | undefined {
  const gh = calls.find((call) => call[0] === 'gh');
  if (!gh) return undefined;
  return gh.at(-1);
}

function readCalls(file: string): string[][] {
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, 'utf8')
    .split('\u001e')
    .filter((record) => record.length > 0)
    .map((record) => record.split('\0').filter((argument) => argument.length > 0));
}

function runRelease(options: { changelog?: string | null; env?: Record<string, string> } = {}): Promise<ReleaseRun> {
  const workdir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-koans-release-'));
  const stubs = path.join(workdir, 'stubs');
  const calls = path.join(workdir, 'calls');

  fs.mkdirSync(stubs);
  for (const command of ['git', 'npm', 'gh']) {
    fs.writeFileSync(path.join(stubs, command), STUB, { mode: 0o755 });
  }
  fs.writeFileSync(path.join(workdir, 'package.json'), JSON.stringify({ name: 'agent-koans', version: VERSION }));
  const changelog = options.changelog === undefined ? CHANGELOG : options.changelog;
  if (changelog !== null) fs.writeFileSync(path.join(workdir, 'CHANGELOG.md'), changelog);

  return new Promise((resolve, reject) => {
    execFile(
      'bash',
      [releaseScript],
      {
        cwd: workdir,
        timeout: 30_000,
        env: { ...process.env, PATH: `${stubs}:${process.env.PATH}`, CALLS: calls, ...options.env },
      },
      (error, stdout) => {
        if (error && typeof error.code !== 'number') return reject(error);
        resolve({ code: error ? (error.code as number) : 0, stdout, calls: readCalls(calls) });
      },
    );
  });
}

describe('release script', () => {
  it('does nothing once the version is tagged', async () => {
    const { code, stdout, calls } = await runRelease({ env: { TAG_EXISTS_EXIT: '0' } });
    expect(code).toBe(0);
    expect(stdout).toContain(`v${VERSION} already released`);
    expect(named(calls)).toEqual(['git rev-parse']);
  });

  it('leaves a version that is on npm but untagged for a human', async () => {
    const { code, stdout, calls } = await runRelease({ env: { ON_NPM_EXIT: '0' } });
    expect(code).toBe(0);
    expect(stdout).toContain('Backfill');
    expect(named(calls)).toEqual(['git rev-parse', 'npm view']);
  });

  it('publishes, tags, pushes the tag and creates the release, in that order', async () => {
    const { code, calls } = await runRelease();
    expect(code).toBe(0);
    expect(named(calls)).toEqual([
      'git rev-parse',
      'npm view',
      'npm publish',
      'git tag',
      'git push',
      'gh release',
    ]);
    expect(calls).toContainEqual(['git', 'tag', `v${VERSION}`]);
    expect(calls).toContainEqual(['git', 'push', 'origin', `v${VERSION}`]);
  });

  it("carries the released version's CHANGELOG section and nothing else", async () => {
    const { calls } = await runRelease();
    const notes = releaseNotes(calls);
    expect(notes).toContain('the note this release must carry');
    expect(notes).not.toContain("the next version's note");
    expect(notes).not.toContain("the previous version's note");
  });

  it('releases with a pointer to the CHANGELOG when the version has no section', async () => {
    const { code, calls } = await runRelease({ changelog: '# agent-koans\n\n## 0.7.0\n\n- only the old one\n' });
    expect(code).toBe(0);
    expect(releaseNotes(calls)).toBe('See CHANGELOG.md');
  });

  it('releases with a pointer to the CHANGELOG when there is no CHANGELOG at all', async () => {
    const { code, calls } = await runRelease({ changelog: null });
    expect(code).toBe(0);
    expect(releaseNotes(calls)).toBe('See CHANGELOG.md');
  });

  it('tags nothing when the publish fails', async () => {
    const { code, calls } = await runRelease({ env: { PUBLISH_EXIT: '1' } });
    expect(code).not.toBe(0);
    expect(named(calls)).toEqual(['git rev-parse', 'npm view', 'npm publish']);
  });
});

describe('release workflow', () => {
  it('runs the release script before the changesets action, which gets no publish input', () => {
    const workflow = parseYaml(fs.readFileSync(releaseWorkflow, 'utf8'));
    const steps: { run?: string; uses?: string; with?: Record<string, unknown> }[] = workflow.jobs.release.steps;

    const scriptStep = steps.findIndex((step) => step.run?.includes('release.sh'));
    const actionStep = steps.findIndex((step) => step.uses?.startsWith('changesets/action@'));
    expect(scriptStep).toBeGreaterThanOrEqual(0);
    expect(actionStep).toBeGreaterThanOrEqual(0);
    expect(scriptStep).toBeLessThan(actionStep);

    expect(steps[actionStep].with?.publish).toBeUndefined();
    expect(fs.existsSync(path.join(repoRoot, /bash (\S+)/.exec(steps[scriptStep].run!)![1]))).toBe(true);
  });
});
