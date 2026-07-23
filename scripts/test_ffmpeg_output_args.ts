import assert from 'node:assert/strict';
import { buildRenderOutputArgs, buildSourceAwareColorArgs, resolveStorageSafeVideoRates } from '../lib/ffmpeg-output-args';

const baseOptions = {
  preset: 'medium',
  crf: '18',
  x264Maxrate: '12M',
  x264Bufsize: '24M',
  hardwareBitrate: '10M',
  hardwareMaxrate: '12M',
  hardwareBufsize: '24M',
  outputFps: 30,
  sourceColor: { colorSpace: 'bt709', colorTransfer: 'bt709', colorPrimaries: 'bt709' },
  volume: 1,
  outputPath: 'output.mp4',
};

const encoderOptions = new Set([
  '-c:v', '-preset', '-crf', '-maxrate', '-bufsize', '-profile:v', '-level',
  '-g', '-keyint_min', '-sc_threshold', '-threads', '-b:v', '-realtime',
]);
const repeatableOptions = new Set(['-map']);
const singletonOptions = new Set([
  '-vf', '-filter_complex', '-r', '-pix_fmt', '-colorspace', '-color_trc',
  '-color_primaries', '-af', '-c:a', '-b:a', '-movflags',
]);

function stripEncoderBlock(args: string[]) {
  const normalized: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const token = args[index];
    if (encoderOptions.has(token)) {
      index += 1;
      continue;
    }
    normalized.push(token);
  }
  return normalized;
}

function assertNoConflictingSingletons(args: string[]) {
  const seen = new Set<string>();
  for (const token of args) {
    if (repeatableOptions.has(token) || !singletonOptions.has(token)) continue;
    assert(!seen.has(token), `duplicate singleton FFmpeg option: ${token}`);
    seen.add(token);
  }
}

function outputArgs(encoder: string) {
  return buildRenderOutputArgs({ ...baseOptions, encoder });
}

const software = outputArgs('libx264');
const hardware = outputArgs('h264_videotoolbox');

assert.deepEqual(stripEncoderBlock(software), stripEncoderBlock(hardware));
assertNoConflictingSingletons(software);
assertNoConflictingSingletons(hardware);
assert.deepEqual(hardware.slice(hardware.indexOf('-profile:v'), hardware.indexOf('-profile:v') + 4), ['-profile:v', 'high', '-realtime', '0']);
assert(!hardware.includes('-q:v'));
assert.equal(hardware[hardware.indexOf('-b:a') + 1], '192k');
assert(!hardware.includes('-ar'), 'render pipeline should not resample audio without a format requirement');

assert.deepEqual(buildSourceAwareColorArgs(baseOptions.sourceColor), [
  '-colorspace', 'bt709', '-color_trc', 'bt709', '-color_primaries', 'bt709',
]);
assert.deepEqual(buildSourceAwareColorArgs({
  colorSpace: 'bt2020nc', colorTransfer: 'smpte2084', colorPrimaries: 'bt2020',
}), [], 'HDR must not be relabelled as BT.709 without tone mapping');
assert.deepEqual(buildSourceAwareColorArgs(null), []);

assert.deepEqual(resolveStorageSafeVideoRates(30), {
  bitrate: '10000k',
  maxrate: '10000k',
  bufsize: '20000k',
});
const longClipRates = resolveStorageSafeVideoRates(90);
assert(Number.parseInt(longClipRates.bitrate, 10) < 4_000, 'long reels must stay below the object-storage upload ceiling');
assert(Number.parseInt(longClipRates.bitrate, 10) >= 1_800, 'long reels must retain a usable video bitrate');

const layoutPrefixes = [
  ['-filter_complex', '[0:v]crop=608:1080:176:0,scale=1080:1920:flags=lanczos+accurate_rnd+full_chroma_int[outv]', '-map', '[outv]', '-map', '0:a?'],
  ['-filter_complex', '[0:v]split=2[top][bottom];[top]crop=608:1080:176:0,scale=1080:952:flags=lanczos+accurate_rnd+full_chroma_int[topv];[bottom]crop=608:1080:1136:0,scale=1080:952:flags=lanczos+accurate_rnd+full_chroma_int[bottomv];[topv][bottomv]vstack=inputs=2[outv]', '-map', '[outv]', '-map', '0:a?'],
  ['-filter_complex', '[0:v]split=3[close][widebg][widefg];[widebg][widefg]overlay=(W-w)/2:(H-h)/2[outv]', '-map', '[outv]', '-map', '0:a?'],
  ['-vf', 'crop=607:1079:176:0,scale=1080:1920:flags=lanczos+accurate_rnd+full_chroma_int,subtitles=captions.ass'],
];

for (const prefix of layoutPrefixes) {
  const softwareCommand = [...prefix, ...software];
  const hardwareCommand = [...prefix, ...hardware];
  assert.deepEqual(stripEncoderBlock(softwareCommand), stripEncoderBlock(hardwareCommand));
  assertNoConflictingSingletons(softwareCommand);
  assertNoConflictingSingletons(hardwareCommand);
}

console.log('FFmpeg output argument regression matrix passed');
