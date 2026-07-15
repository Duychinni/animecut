import { z } from 'zod';

export const DIARIZATION_SCHEMA_VERSION = 1;

export const speakerTurnSchema = z.object({
  start_sec: z.number().finite().nonnegative(),
  end_sec: z.number().finite().positive(),
  speaker_key: z.string().min(1).nullable(),
  confidence: z.number().min(0).max(1).nullable(),
  confidence_source: z.string().min(1).nullable(),
  overlap: z.boolean(),
  classification: z.enum(['speech', 'silence', 'music_or_broll', 'unknown']),
}).refine((turn) => turn.end_sec > turn.start_sec, {
  message: 'Speaker turn end must be after start',
});

export const sourceSpeakerSchema = z.object({
  speaker_key: z.string().regex(/^speaker_[a-z]+$/),
  evidence_duration_sec: z.number().finite().nonnegative(),
  embedding_index: z.number().int().nonnegative(),
  embedding_dimension: z.number().int().positive(),
});

export const diarizationArtifactSchema = z.object({
  schema_version: z.literal(DIARIZATION_SCHEMA_VERSION),
  provider: z.literal('pyannote'),
  provider_version: z.string().min(1),
  model: z.string().min(1),
  model_revision: z.string().min(1),
  embedding_model: z.string().min(1),
  embedding_model_revision: z.string().min(1),
  duration_sec: z.number().finite().nonnegative(),
  embedding_file: z.string().min(1),
  speakers: z.array(sourceSpeakerSchema),
  turns: z.array(speakerTurnSchema),
  diagnostics: z.object({
    speech_turn_count: z.number().int().nonnegative(),
    overlap_turn_count: z.number().int().nonnegative(),
    non_speech_range_count: z.number().int().nonnegative(),
    confidence_source: z.string().min(1),
  }),
});

export type DiarizationArtifact = z.infer<typeof diarizationArtifactSchema>;
export type SpeakerTurn = z.infer<typeof speakerTurnSchema>;
export type SourceSpeaker = z.infer<typeof sourceSpeakerSchema>;
