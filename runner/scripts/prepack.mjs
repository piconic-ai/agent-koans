// Pack-time copy of package contents that live outside runner/: the
// koans and the repository README and LICENSE. postpack.mjs removes
// them again, and runner/.gitignore hides them in between.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const runnerDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = path.resolve(runnerDir, '..');

fs.rmSync(path.join(runnerDir, 'koans'), { recursive: true, force: true });
fs.cpSync(path.join(repoRoot, 'koans'), path.join(runnerDir, 'koans'), { recursive: true });
for (const file of ['README.md', 'LICENSE']) {
  fs.copyFileSync(path.join(repoRoot, file), path.join(runnerDir, file));
}
