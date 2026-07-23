import assert from 'node:assert/strict';
import test from 'node:test';
import { AD_ASSET_MAX_UPLOAD_BYTES, AD_STUDIO_MAX_UPLOAD_BYTES, AD_STUDIO_UPLOAD_ACCEPT, isAllowedAdStudioUpload } from '../lib/ad-studio-upload';

test('Ad Studio exposes and accepts common OBS recording containers', () => {
  for (const [name, type] of [
    ['recording.mp4', 'video/mp4'],
    ['recording.mov', 'video/quicktime'],
    ['recording.webm', 'video/webm'],
    ['recording.mkv', 'video/x-matroska'],
    ['recording.flv', 'video/x-flv'],
  ]) {
    assert.equal(isAllowedAdStudioUpload({ name, type }), true, `${name} should be accepted`);
  }
  assert.match(AD_STUDIO_UPLOAD_ACCEPT, /\.mkv/);
  assert.match(AD_STUDIO_UPLOAD_ACCEPT, /\.flv/);
});

test('Ad Studio rejects disguised files and retains its 300 MB limit', () => {
  assert.equal(isAllowedAdStudioUpload({ name: 'recording.exe', type: 'video/mp4' }), false);
  assert.equal(isAllowedAdStudioUpload({ name: 'recording.mkv', type: 'text/plain' }), true);
  assert.equal(isAllowedAdStudioUpload({ name: 'recording.mkv', type: 'application/x-matroska' }), true);
  assert.equal(isAllowedAdStudioUpload({ name: 'recording.mkv', type: '' }), true);
  assert.equal(AD_STUDIO_MAX_UPLOAD_BYTES, 300 * 1024 * 1024);
  assert.equal(AD_ASSET_MAX_UPLOAD_BYTES, 5 * 1024 * 1024 * 1024);
});
