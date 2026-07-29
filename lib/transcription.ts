import { createReadStream, existsSync } from 'node:fs';
import { mkdir, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { openai } from '@/lib/openai';
import { buildMockTranscript, isMockTranscriptionEnabled } from '@/lib/dev-ai';

type TranscriptSegment = Record<string, unknown> & {
  start?: number;
  end?: number;
  text?: string;
  words?: Array<Record<string, unknown> & { start?: number; end?: number }>;
};

type TranscriptWord = Record<string, unknown> & {
  start?: number;
  end?: number;
  word?: string;
};

function normalizedToken(value: unknown) {
  return String(value ?? '').toLowerCase().replace(/[^a-z0-9']/g, '');
}

function distributeWords(
  tokens: string[],
  start: number,
  end: number,
): TranscriptWord[] {
  const safeEnd = end > start ? end : start + tokens.length * 0.02;
  const weights = tokens.map((token) => Math.max(1, normalizedToken(token).length));
  const totalWeight = weights.reduce((sum, weight) => sum + weight, 0) || tokens.length;
  let cursor = start;
  return tokens.map((token, index) => {
    const wordStart = cursor;
    cursor = index === tokens.length - 1
      ? safeEnd
      : cursor + ((safeEnd - start) * weights[index]) / totalWeight;
    return {
      word: token,
      start: wordStart,
      end: cursor,
      timing_source: 'interpolated',
    };
  });
}

export function reconcileSegmentWords(segment: TranscriptSegment, timedWords: TranscriptWord[]) {
  const textTokens = String(segment.text ?? '').trim().split(/\s+/).filter(Boolean);
  if (!textTokens.length || !timedWords.length) return timedWords;

  const textNormalized = textTokens.map(normalizedToken);
  const timedNormalized = timedWords.map((word) => normalizedToken(word.word));
  const rows = textTokens.length + 1;
  const columns = timedWords.length + 1;
  const lcs = Array.from({ length: rows }, () => new Uint16Array(columns));

  for (let textIndex = textTokens.length - 1; textIndex >= 0; textIndex -= 1) {
    for (let timedIndex = timedWords.length - 1; timedIndex >= 0; timedIndex -= 1) {
      lcs[textIndex][timedIndex] = textNormalized[textIndex] && textNormalized[textIndex] === timedNormalized[timedIndex]
        ? lcs[textIndex + 1][timedIndex + 1] + 1
        : Math.max(lcs[textIndex + 1][timedIndex], lcs[textIndex][timedIndex + 1]);
    }
  }

  const matchedTimedIndex = new Array<number | null>(textTokens.length).fill(null);
  let textIndex = 0;
  let timedIndex = 0;
  while (textIndex < textTokens.length && timedIndex < timedWords.length) {
    if (textNormalized[textIndex] && textNormalized[textIndex] === timedNormalized[timedIndex]) {
      matchedTimedIndex[textIndex] = timedIndex;
      textIndex += 1;
      timedIndex += 1;
    } else if (lcs[textIndex + 1][timedIndex] >= lcs[textIndex][timedIndex + 1]) {
      textIndex += 1;
    } else {
      timedIndex += 1;
    }
  }

  const output = new Array<TranscriptWord | null>(textTokens.length).fill(null);
  for (let index = 0; index < textTokens.length; index += 1) {
    const matched = matchedTimedIndex[index];
    if (matched === null) continue;
    output[index] = { ...timedWords[matched], word: textTokens[index] };
  }

  let cursor = 0;
  while (cursor < textTokens.length) {
    if (output[cursor]) {
      cursor += 1;
      continue;
    }
    const runStart = cursor;
    while (cursor < textTokens.length && !output[cursor]) cursor += 1;
    const runEnd = cursor;
    const previous = runStart > 0 ? output[runStart - 1] : null;
    const next = runEnd < output.length ? output[runEnd] : null;
    const segmentStart = Number(segment.start);
    const segmentEnd = Number(segment.end);
    const leftBoundary = Number.isFinite(Number(previous?.end))
      ? Number(previous?.end)
      : Number.isFinite(segmentStart) ? segmentStart : Number(next?.start) || 0;
    const rightBoundary = Number.isFinite(Number(next?.start))
      ? Number(next?.start)
      : Number.isFinite(segmentEnd) ? segmentEnd : leftBoundary + (runEnd - runStart) * 0.12;
    const missingTokens = textTokens.slice(runStart, runEnd);
    const availableGap = rightBoundary - leftBoundary;

    if (availableGap >= missingTokens.length * 0.04) {
      const inferred = distributeWords(missingTokens, leftBoundary, rightBoundary);
      inferred.forEach((word, offset) => { output[runStart + offset] = word; });
      continue;
    }

    // Whisper sometimes folds an omitted word into the following word's
    // interval (for example “gonna cost” receives only a timestamp for
    // “cost”). Split that real acoustic interval across both words.
    if (next && Number.isFinite(Number(next.end))) {
      const combined = distributeWords(
        [...missingTokens, String(next.word ?? textTokens[runEnd])],
        Math.max(leftBoundary, Number(next.start)),
        Number(next.end),
      );
      combined.forEach((word, offset) => { output[runStart + offset] = word; });
      continue;
    }

    const inferred = distributeWords(missingTokens, leftBoundary, rightBoundary);
    inferred.forEach((word, offset) => { output[runStart + offset] = word; });
  }

  return output.filter((word): word is TranscriptWord => Boolean(word));
}

export type TranscriptResult = {
  language: string;
  fullText: string;
  segments: TranscriptSegment[];
};

type TranscriptionProgress = {
  completedChunks: number;
  totalChunks: number;
  resumedChunks: number;
};

type TranscriptionOptions = {
  onProgress?: (progress: TranscriptionProgress) => void | Promise<void>;
};

const OPENAI_SAFE_FILE_BYTES = 24 * 1024 * 1024;
const CHUNK_CORE_SECONDS = 12 * 60;
const CHUNK_OVERLAP_SECONDS = 2;
const CHUNK_CACHE_VERSION = 3;

function getTranscriptionProvider() {
  return (process.env.TRANSCRIPTION_PROVIDER || 'openai').trim().toLowerCase();
}

function forcedAlignmentEnabled() {
  return !['0', 'false', 'no', 'off'].includes(
    (process.env.CAPTION_ALIGNMENT_ENABLED || 'true').trim().toLowerCase(),
  );
}

async function runProcess(command: string, args: string[], name: string) {
  return await new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
    const proc = spawn(command, args);
    let stdout = '';
    let stderr = '';

    proc.stdout?.on('data', (chunk) => {
      stdout += chunk.toString();
    });
    proc.stderr?.on('data', (chunk) => {
      stderr = `${stderr}${chunk.toString()}`.slice(-64_000);
    });
    proc.on('close', (code) => {
      if (code === 0) resolve({ stdout, stderr });
      else {
        const details = (stderr.trim() || stdout.trim())
          .split('\n')
          .slice(-8)
          .join(' | ');
        reject(new Error(`${name} failed with code ${code}: ${details}`));
      }
    });
    proc.on('error', reject);
  });
}

export function parsePythonTranscriberOutput(stdout: string) {
  const trimmed = stdout.trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    // WhisperX and its ML dependencies can print model/loading diagnostics to
    // stdout even when the wrapper's final line is valid JSON. Prefer the last
    // parseable line so those diagnostics cannot discard a completed alignment.
    const lines = trimmed.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    for (let index = lines.length - 1; index >= 0; index -= 1) {
      try {
        return JSON.parse(lines[index]);
      } catch {
        // Continue looking for the wrapper's JSON result.
      }
    }
    throw new Error('Python transcriber output did not contain valid JSON');
  }
}

async function runPythonTranscriber(args: string[], providerName: string) {
  const { stdout, stderr } = await runProcess(args[0], args.slice(1), providerName);
  try {
    const parsed = parsePythonTranscriberOutput(stdout || '{}');
    if (parsed?.error) throw new Error(parsed.error);
    return {
      language: parsed?.language || 'en',
      fullText: parsed?.fullText || '',
      segments: Array.isArray(parsed?.segments) ? parsed.segments : [],
    } as TranscriptResult;
  } catch (error) {
    throw new Error(`${providerName} returned invalid JSON: ${stderr || String(error)}`);
  }
}

async function transcribeWithFasterWhisper(filePath: string) {
  const pythonBin = process.env.FASTER_WHISPER_PYTHON || process.env.SMART_REFRAME_PYTHON || 'python3';
  const scriptPath = process.env.FASTER_WHISPER_SCRIPT || `${process.cwd()}/scripts/transcribe_faster_whisper.py`;
  const modelName = process.env.FASTER_WHISPER_MODEL || 'base';
  const device = process.env.FASTER_WHISPER_DEVICE || 'cpu';
  const computeType = process.env.FASTER_WHISPER_COMPUTE_TYPE || 'int8';

  return await runPythonTranscriber([pythonBin, scriptPath, filePath, modelName, device, computeType], 'faster-whisper');
}

async function transcribeWithWhisperX(filePath: string) {
  const pythonBin = process.env.WHISPERX_PYTHON || process.env.SMART_REFRAME_PYTHON || 'python3';
  const scriptPath = process.env.WHISPERX_SCRIPT || `${process.cwd()}/scripts/transcribe_whisperx.py`;
  const modelName = process.env.WHISPERX_MODEL || 'base';
  const device = process.env.WHISPERX_DEVICE || 'cpu';
  const computeType = process.env.WHISPERX_COMPUTE_TYPE || 'int8';

  return await runPythonTranscriber([pythonBin, scriptPath, filePath, modelName, device, computeType], 'whisperx');
}

async function transcribeWithOpenAI(filePath: string): Promise<TranscriptResult> {
  const transcript = await openai.audio.transcriptions.create({
    file: createReadStream(filePath),
    model: 'whisper-1',
    response_format: 'verbose_json',
    timestamp_granularities: ['segment', 'word'],
  });

  const verbose = transcript as unknown as {
    language?: string;
    segments?: TranscriptSegment[];
    words?: TranscriptWord[];
  };

  return {
    language: verbose.language ?? 'en',
    fullText: transcript.text ?? '',
    segments: attachWordsToSegments(verbose.segments ?? [], verbose.words ?? []),
  };
}

async function alignTranscriptWords(filePath: string, transcript: TranscriptResult) {
  if (!forcedAlignmentEnabled()) return transcript;

  const pythonBin = process.env.WHISPERX_PYTHON || process.env.SMART_REFRAME_PYTHON || 'python3';
  const scriptPath = process.env.CAPTION_ALIGNMENT_SCRIPT
    || `${process.cwd()}/scripts/align_transcript_whisperx.py`;
  const device = process.env.WHISPERX_DEVICE || 'cpu';
  const transcriptPath = `${filePath}.caption-alignment-${process.pid}-${Date.now()}.json`;

  await writeFile(transcriptPath, JSON.stringify(transcript), 'utf8');
  try {
    const aligned = await runPythonTranscriber(
      [pythonBin, scriptPath, filePath, transcriptPath, device],
      'whisperx forced alignment',
    );
    return aligned;
  } finally {
    await unlink(transcriptPath).catch(() => undefined);
  }
}

export function attachWordsToSegments(segments: TranscriptSegment[], words: TranscriptWord[]) {
  const normalizedWords = words
    .map((word) => ({
      ...word,
      start: Number(word.start),
      end: Number(word.end),
      word: String(word.word ?? '').trim(),
    }))
    .filter((word) => word.word && Number.isFinite(word.start) && Number.isFinite(word.end) && word.end > word.start);
  if (!normalizedWords.length) return segments;

  const assigned = segments.map(() => [] as TranscriptWord[]);
  for (const word of normalizedWords) {
    const midpoint = (Number(word.start) + Number(word.end)) / 2;
    let bestIndex = -1;
    let bestDistance = Number.POSITIVE_INFINITY;

    for (let index = 0; index < segments.length; index += 1) {
      const start = Number(segments[index].start);
      const end = Number(segments[index].end);
      if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) continue;

      const distance = midpoint < start
        ? start - midpoint
        : midpoint > end
          ? midpoint - end
          : 0;
      if (distance < bestDistance) {
        bestDistance = distance;
        bestIndex = index;
      }
      if (distance === 0) break;
    }

    // Permit only tiny timestamp-rounding gaps. A malformed response must not
    // attach a word to a distant sentence and create incorrect captions.
    if (bestIndex >= 0 && bestDistance <= 0.25) assigned[bestIndex].push(word);
  }

  return segments.map((segment, index) => assigned[index].length
    ? { ...segment, words: reconcileSegmentWords(segment, assigned[index]) }
    : segment);
}

async function transcribeOneFile(filePath: string, provider: string) {
  if (provider === 'faster-whisper') return await transcribeWithFasterWhisper(filePath);
  if (provider === 'whisperx') return await transcribeWithWhisperX(filePath);
  return await transcribeWithOpenAI(filePath);
}

async function probeDurationSeconds(filePath: string) {
  const ffprobe = process.env.FFPROBE_PATH?.trim() || 'ffprobe';
  const { stdout } = await runProcess(ffprobe, [
    '-v', 'error',
    '-show_entries', 'format=duration',
    '-of', 'default=noprint_wrappers=1:nokey=1',
    filePath,
  ], 'ffprobe');
  const duration = Number(stdout.trim());
  if (!Number.isFinite(duration) || duration <= 0) throw new Error('Could not determine audio duration for transcription');
  return duration;
}

async function retry<T>(operation: () => Promise<T>, attempts = 3): Promise<T> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      if (attempt < attempts) await new Promise((resolve) => setTimeout(resolve, 750 * (2 ** (attempt - 1))));
    }
  }
  throw lastError;
}

function offsetSegment(segment: TranscriptSegment, offset: number): TranscriptSegment {
  const shifted = { ...segment };
  if (Number.isFinite(Number(segment.start))) shifted.start = Number(segment.start) + offset;
  if (Number.isFinite(Number(segment.end))) shifted.end = Number(segment.end) + offset;
  if (Array.isArray(segment.words)) {
    shifted.words = segment.words.map((word) => ({
      ...word,
      ...(Number.isFinite(Number(word.start)) ? { start: Number(word.start) + offset } : {}),
      ...(Number.isFinite(Number(word.end)) ? { end: Number(word.end) + offset } : {}),
    }));
  }
  return shifted;
}

export function mergeChunkTranscripts(chunks: Array<{
  coreStart: number;
  coreEnd: number;
  extractionStart: number;
  transcript: TranscriptResult;
}>): TranscriptResult {
  const sorted = [...chunks].sort((a, b) => a.coreStart - b.coreStart);
  const segments = sorted.flatMap((chunk, index) => chunk.transcript.segments
    .map((segment) => offsetSegment(segment, chunk.extractionStart))
    .flatMap((segment) => {
      const ownsTime = (start: number, end: number) => {
        const midpoint = (start + end) / 2;
        return midpoint >= chunk.coreStart
          && (index === sorted.length - 1 ? midpoint <= chunk.coreEnd : midpoint < chunk.coreEnd);
      };
      const words = Array.isArray(segment.words)
        ? segment.words.filter((word) => {
            const start = Number(word.start);
            const end = Number(word.end);
            return Number.isFinite(start) && Number.isFinite(end) && end > start && ownsTime(start, end);
          })
        : [];

      // Assign overlap ownership per word, not per segment. Whisper can create
      // a segment that straddles a chunk boundary; selecting the whole segment
      // by midpoint can otherwise duplicate or drop several spoken words.
      if (Array.isArray(segment.words) && segment.words.length) {
        if (!words.length) return [];
        return [{
          ...segment,
          start: Number(words[0].start),
          end: Number(words[words.length - 1].end),
          text: words.map((word) => String(word.word ?? '').trim()).filter(Boolean).join(' '),
          words,
        }];
      }

      const start = Number(segment.start ?? chunk.coreStart);
      const end = Number(segment.end ?? start);
      return ownsTime(start, end) ? [segment] : [];
    }));

  const segmentText = segments
    .map((segment) => String(segment.text ?? '').trim())
    .filter(Boolean)
    .join(' ')
    .trim();

  return {
    language: sorted.find((chunk) => chunk.transcript.language)?.transcript.language ?? 'en',
    fullText: segmentText || sorted.map((chunk) => chunk.transcript.fullText.trim()).filter(Boolean).join(' '),
    segments,
  };
}

async function readCachedTranscript(cachePath: string): Promise<TranscriptResult | null> {
  try {
    const parsed = JSON.parse(await readFile(cachePath, 'utf8')) as { version?: number; transcript?: TranscriptResult };
    return parsed.version === CHUNK_CACHE_VERSION && parsed.transcript ? parsed.transcript : null;
  } catch {
    return null;
  }
}

async function writeCachedTranscript(cachePath: string, transcript: TranscriptResult) {
  const temporaryPath = `${cachePath}.${process.pid}.tmp`;
  await writeFile(temporaryPath, JSON.stringify({ version: CHUNK_CACHE_VERSION, transcript }), 'utf8');
  await rename(temporaryPath, cachePath);
}

async function extractChunk(inputPath: string, outputPath: string, start: number, duration: number) {
  if (existsSync(outputPath) && (await stat(outputPath)).size > 1024) return;
  const ffmpeg = process.env.FFMPEG_PATH?.trim() || 'ffmpeg';
  await runProcess(ffmpeg, [
    '-y',
    '-ss', String(start),
    '-t', String(duration),
    '-i', inputPath,
    '-vn',
    '-ac', '1',
    '-ar', '16000',
    '-c:a', 'mp3',
    '-b:a', '64k',
    outputPath,
  ], 'ffmpeg audio chunking');
  const chunkSize = (await stat(outputPath)).size;
  if (chunkSize >= OPENAI_SAFE_FILE_BYTES) {
    throw new Error(`Transcription chunk is unexpectedly large (${Math.ceil(chunkSize / 1024 / 1024)} MB)`);
  }
}

async function transcribeChunked(filePath: string, provider: string, options: TranscriptionOptions) {
  const duration = await probeDurationSeconds(filePath);
  const source = await stat(filePath);
  // Key by the deterministic extracted-audio size rather than mtime. Pipeline
  // retries may recreate the same MP3, and completed chunk transcripts should
  // remain reusable across that retry.
  const cacheDir = `${filePath}.transcription-chunks-v${CHUNK_CACHE_VERSION}-${source.size}`;
  await mkdir(cacheDir, { recursive: true });

  const totalChunks = Math.ceil(duration / CHUNK_CORE_SECONDS);
  let completedChunks = 0;
  let resumedChunks = 0;
  const results = new Array<{
    coreStart: number;
    coreEnd: number;
    extractionStart: number;
    transcript: TranscriptResult;
  }>(totalChunks);
  let nextIndex = 0;
  const concurrency = Math.max(1, Math.min(4, Number(process.env.TRANSCRIPTION_CHUNK_CONCURRENCY) || 2));

  const worker = async () => {
    while (true) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= totalChunks) return;

      const coreStart = index * CHUNK_CORE_SECONDS;
      const coreEnd = Math.min(duration, (index + 1) * CHUNK_CORE_SECONDS);
      const extractionStart = Math.max(0, coreStart - CHUNK_OVERLAP_SECONDS);
      const extractionEnd = Math.min(duration, coreEnd + CHUNK_OVERLAP_SECONDS);
      const chunkPath = path.join(cacheDir, `chunk-${String(index).padStart(3, '0')}.mp3`);
      const transcriptPath = path.join(cacheDir, `chunk-${String(index).padStart(3, '0')}.json`);

      let transcript = await readCachedTranscript(transcriptPath);
      if (transcript) {
        resumedChunks += 1;
      } else {
        await extractChunk(filePath, chunkPath, extractionStart, extractionEnd - extractionStart);
        transcript = await retry(() => transcribeOneFile(chunkPath, provider));
        await writeCachedTranscript(transcriptPath, transcript);
      }

      results[index] = { coreStart, coreEnd, extractionStart, transcript };
      completedChunks += 1;
      await options.onProgress?.({ completedChunks, totalChunks, resumedChunks });
    }
  };

  await Promise.all(Array.from({ length: Math.min(concurrency, totalChunks) }, () => worker()));
  return mergeChunkTranscripts(results);
}

function requireWordTimingCoverage(transcript: TranscriptResult) {
  const spokenWordCount = transcript.segments.reduce(
    (total, segment) => total + String(segment.text ?? '').trim().split(/\s+/).filter(Boolean).length,
    0,
  );
  const timedWordCount = transcript.segments.reduce(
    (total, segment) => total + (Array.isArray(segment.words)
      ? segment.words.filter((word) => word.timing_source !== 'interpolated').length
      : 0),
    0,
  );
  if (spokenWordCount > 0 && timedWordCount / spokenWordCount < 0.75) {
    throw new Error(
      `Transcription word timing coverage was too low (${timedWordCount}/${spokenWordCount}); refusing to render guessed caption timing`,
    );
  }
  return transcript;
}

export async function transcribeAudioFile(filePath: string, options: TranscriptionOptions = {}) {
  if (isMockTranscriptionEnabled()) return buildMockTranscript();

  const provider = getTranscriptionProvider();
  const fileSize = (await stat(filePath)).size;
  const duration = provider === 'openai' ? await probeDurationSeconds(filePath) : 0;
  let transcript: TranscriptResult;
  // A compressed long recording can be well below OpenAI's upload-size limit
  // while still leaving one request running for several minutes. Split long
  // sources too, so each request is bounded and successful chunks survive a
  // retry instead of restarting the complete transcription.
  if (provider !== 'openai' || (fileSize < OPENAI_SAFE_FILE_BYTES && duration <= CHUNK_CORE_SECONDS)) {
    transcript = await transcribeOneFile(filePath, provider);
  } else {
    transcript = await transcribeChunked(filePath, provider, options);
  }

  // Align once against the complete waveform after chunk merging. This avoids
  // repeatedly loading the acoustic model for every 12-minute chunk while
  // correcting both native and interpolated Whisper word boundaries.
  const aligned = provider === 'whisperx'
    ? transcript
    : await alignTranscriptWords(filePath, transcript);
  return requireWordTimingCoverage(aligned);
}
