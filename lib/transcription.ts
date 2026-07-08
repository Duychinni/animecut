import { createReadStream } from 'node:fs';
import { spawn } from 'node:child_process';
import { openai } from '@/lib/openai';
import { buildMockTranscript, isMockAiEnabled } from '@/lib/dev-ai';

function getTranscriptionProvider() {
  return (process.env.TRANSCRIPTION_PROVIDER || 'openai').trim().toLowerCase();
}

async function runPythonTranscriber(args: string[], providerName: string) {
  return await new Promise<{ language: string; fullText: string; segments: unknown[] }>((resolve, reject) => {
    const proc = spawn(args[0], args.slice(1));
    let stdout = '';
    let stderr = '';

    proc.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });
    proc.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });

    proc.on('close', (code) => {
      try {
        const parsed = JSON.parse(stdout || '{}');
        if (code !== 0 || parsed?.error) {
          reject(new Error(parsed?.error || stderr || `${providerName} failed with code ${code}`));
          return;
        }
        resolve({
          language: parsed?.language || 'en',
          fullText: parsed?.fullText || '',
          segments: Array.isArray(parsed?.segments) ? parsed.segments : [],
        });
      } catch (error) {
        reject(new Error(`${providerName} returned invalid JSON: ${stderr || String(error)}`));
      }
    });

    proc.on('error', reject);
  });
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
    let stdout = '';
    let stderr = '';

    proc.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });
    proc.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });

    proc.on('close', (code) => {
      try {
        const parsed = JSON.parse(stdout || '{}');
        if (code !== 0 || parsed?.error) {
          reject(new Error(parsed?.error || stderr || `faster-whisper failed with code ${code}`));
          return;
        }
        resolve({
          language: parsed?.language || 'en',
          fullText: parsed?.fullText || '',
          segments: Array.isArray(parsed?.segments) ? parsed.segments : [],
        });
      } catch (error) {
        reject(new Error(`faster-whisper returned invalid JSON: ${stderr || String(error)}`));
      }
    });

    proc.on('error', reject);
  });
}

export async function transcribeAudioFile(filePath: string) {
  if (isMockAiEnabled()) {
    return buildMockTranscript();
  }

  const provider = getTranscriptionProvider();
  if (provider === 'faster-whisper') {
    return await transcribeWithFasterWhisper(filePath);
  }
  if (provider === 'whisperx') {
    return await transcribeWithWhisperX(filePath);
  }

  const transcript = await openai.audio.transcriptions.create({
    file: createReadStream(filePath),
    model: 'whisper-1',
    response_format: 'verbose_json',
    timestamp_granularities: ['segment', 'word'],
  });

  const fullText = transcript.text ?? '';
  const segments = (transcript as unknown as { segments?: unknown[] }).segments ?? [];

  return {
    language: (transcript as unknown as { language?: string }).language ?? 'en',
    fullText,
    segments,
  };
}
