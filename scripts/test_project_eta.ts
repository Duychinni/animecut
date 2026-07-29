import assert from 'node:assert/strict';
import { estimateObservedRenderEtaSeconds } from '../lib/project-eta';

const queuedEta = estimateObservedRenderEtaSeconds({
  pipelineStatus: 'queued',
  pipelineStage: 'queued',
  readyExports: 0,
  exportCount: 0,
  exportRows: [],
  sourceDurationSeconds: 30 * 60,
  elapsedSeconds: 0,
});
assert.ok(queuedEta && queuedEta > 8 * 60, 'a long queued source should show a full-pipeline ETA');

const transcriptionEta = estimateObservedRenderEtaSeconds({
  pipelineStatus: 'processing',
  pipelineStage: 'transcribing',
  readyExports: 0,
  exportCount: 0,
  exportRows: [],
  sourceDurationSeconds: 30 * 60,
  elapsedSeconds: 90,
});
assert.ok(transcriptionEta && transcriptionEta > 5 * 60, 'transcription should retain downstream work in its ETA');
assert.ok(transcriptionEta! < queuedEta!, 'ETA should decrease as the pipeline advances');

const renderStartupEta = estimateObservedRenderEtaSeconds({
  pipelineStatus: 'processing',
  pipelineStage: 'rendering',
  readyExports: 0,
  exportCount: 15,
  exportRows: [{ created_at: new Date().toISOString() }],
  sourceDurationSeconds: 30 * 60,
});
assert.ok(renderStartupEta && renderStartupEta >= 5 * 60, 'rendering must show ETA before the first reel completes');

const nowMs = Date.now();
const observedRenderEta = estimateObservedRenderEtaSeconds({
  pipelineStatus: 'processing',
  pipelineStage: 'rendering',
  readyExports: 6,
  exportCount: 15,
  exportRows: [{ created_at: new Date(nowMs - 180_000).toISOString() }],
  sourceDurationSeconds: 30 * 60,
  nowMs,
});
assert.ok(observedRenderEta && observedRenderEta >= 4 * 60, 'render ETA should use measured project throughput');

assert.equal(estimateObservedRenderEtaSeconds({
  pipelineStatus: 'completed',
  pipelineStage: 'completed',
  readyExports: 15,
  exportCount: 15,
  exportRows: [],
}), null);

console.log('PASS full-pipeline ETA estimates');
