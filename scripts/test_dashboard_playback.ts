import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const board = readFileSync(new URL('../components/clips/TopClipsBoard.tsx', import.meta.url), 'utf8');
const worker = readFileSync(new URL('../app/api/jobs/process/route.ts', import.meta.url), 'utf8');

assert.match(board, /const adaptiveUrl = clip\.preview360Url \?\? clip\.preview540Url/);
assert.match(board, /preload="none"/);
assert.doesNotMatch(board, /IntersectionObserver|requestIdleCallback/);

const requiredPreviewIndex = worker.indexOf("await renderPlaybackPreview(outPath, requiredPreview360Path, '360p')");
const readyIndex = worker.indexOf("status: 'done'", requiredPreviewIndex);
assert.ok(requiredPreviewIndex >= 0, 'main render must create a required 360p playback rendition');
assert.ok(readyIndex > requiredPreviewIndex, 'the reel must not become ready before its 360p playback rendition exists');
assert.match(worker, /preview_360_storage_path: requiredPreview360Upload\.path/);
assert.match(worker, /options\?\.preview_only === true && options\?\.editor_preview_only !== true/);
assert.doesNotMatch(
  worker,
  /renderAdaptivePlaybackPreviews\(outPath,\s*preview360Path,\s*preview540Path\)/,
  'background playback work must not regenerate the required 360p preview',
);

const editorRoute = readFileSync(new URL('../app/api/clips/[clipId]/edit/route.ts', import.meta.url), 'utf8');
assert.match(editorRoute, /editor_preview_only: true/);
assert.match(worker, /options\?\.preview_only === true && options\?\.editor_preview_only === true/);

console.log('Dashboard reels require a lightweight on-demand playback rendition before completion.');
