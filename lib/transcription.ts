import { createReadStream } from 'node:fs';
import { openai } from '@/lib/openai';

export async function transcribeAudioFile(filePath: string) {
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
