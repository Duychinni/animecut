import { createReadStream, existsSync } from 'node:fs';
import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
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
const CHUNK_CACHE_VERSION = 2;

function getTranscriptionProvider() {
  return (process.env.TRANSCRIPTION_PROVIDER || 'openai').trim().toLowerCase();
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
      else reject(new Error(`${name} failed with code ${code}: ${stderr.trim().split('\n').slice(-8).join(' | ')}`));
    });
    proc.on('error', reject);
  });
}

async function runPythonTranscriber(args: string[], providerName: string) {
  const { stdout, stderr } = await runProcess(args[0], args.slice(1), providerName);
  try {
    const parsed = JSON.parse(stdout || '{}');
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

  return {
    language: (transcript as unknown as { language?: string }).language ?? 'en',
    fullText: transcript.text ?? '',
    segments: ((transcript as unknown as { segments?: TranscriptSegment[] }).segments ?? []),
  };
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

export async function transcribeAudioFile(filePath: string, options: TranscriptionOptions = {}) {
  if (isMockTranscriptionEnabled()) return buildMockTranscript();

  const provider = getTranscriptionProvider();
  const fileSize = (await stat(filePath)).size;
  if (provider !== 'openai' || fileSize < OPENAI_SAFE_FILE_BYTES) {
    return await transcribeOneFile(filePath, provider);
  }

  return await transcribeChunked(filePath, provider, options);
}
