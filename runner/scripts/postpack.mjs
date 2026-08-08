// Removes what prepack.mjs copied into runner/ for packing.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const runnerDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

for (const entry of ['koans', 'README.md', 'LICENSE']) {
  fs.rmSync(path.join(runnerDir, entry), { recursive: true, force: true });
}
