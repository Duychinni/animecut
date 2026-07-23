import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import path from 'node:path';

test('vertical reel rendering never adds black letterbox padding', () => {
  const ffmpegSource = readFileSync(path.join(process.cwd(), 'lib', 'ffmpeg.ts'), 'utf8');
  assert.doesNotMatch(
    ffmpegSource,
    /pad=\$\{(?:outputWidth|VERTICAL_EXPORT_WIDTH)\}:\$\{(?:outputHeight|VERTICAL_EXPORT_HEIGHT)\}:[^`\n]*black/,
  );
});

test('compatibility fallback uses a full-canvas crop', () => {
  const processSource = readFileSync(path.join(process.cwd(), 'app', 'api', 'jobs', 'process', 'route.ts'), 'utf8');
  assert.match(processSource, /framingMode:\s*safeLayoutFallback\s*\?\s*'center'/);
});
