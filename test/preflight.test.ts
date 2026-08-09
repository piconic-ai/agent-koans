// What preflight promises: a healthy agent passes, a command that dies
// is diagnosed with its exit code and captured output, and a process
// that runs without serving /health is diagnosed with the address it
// never answered.
import { describe, expect, it } from 'vitest';
import { preflight } from '../src/preflight.js';

const NODE_SERVER =
  'node -e "const h=require(\'http\');h.createServer((q,s)=>s.end(\'ok\')).listen(process.env.PORT)"';

describe('preflight', () => {
  it('passes a healthy agent', { timeout: 15_000 }, async () => {
    expect(await preflight({ command: NODE_SERVER })).toBeNull();
  });

  it('diagnoses a command that cannot start', { timeout: 15_000 }, async () => {
    const problem = await preflight({ command: 'node no-such-server.js' });
    expect(problem).toContain('exited with code');
    expect(problem).toContain('before answering GET /health');
    expect(problem).toContain('Cannot find module');
  });

  it('diagnoses a process that never serves /health', { timeout: 15_000 }, async () => {
    const problem = await preflight({
      command: 'node -e "setInterval(()=>{},1000)"',
      startupTimeoutMs: 1_500,
    });
    expect(problem).toContain('never answered GET /health');
    expect(problem).toContain('read PORT');
  });
});
