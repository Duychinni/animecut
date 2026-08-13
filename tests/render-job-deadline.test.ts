import assert from 'node:assert/strict';
import test from 'node:test';
import { runWithRenderJobDeadline } from '../lib/render-deadline';

test('returns a render operation that finishes before its deadline', async () => {
  const result = await runWithRenderJobDeadline(Promise.resolve('done'), {
    exportId: 'export-fast',
    timeoutMs: 100,
  });
  assert.equal(result, 'done');
});

test('rejects an orphaned render so its heartbeat can stop and retry can run', async () => {
  const neverFinishes = new Promise<never>(() => {});
  await assert.rejects(
    runWithRenderJobDeadline(neverFinishes, { exportId: 'export-stuck', timeoutMs: 20 }),
    /render job timed out.*export-stuck/i,
  );
});
