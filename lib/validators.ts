import { z } from 'zod';

export const createProjectSchema = z.object({
  title: z.string().min(2),
  source_type: z.enum(['upload', 'youtube']),
  source_url: z.string().url().optional(),
  rights_confirmed: z.literal(true, {
    error: 'You must confirm that you have permission to process this content.',
  }),
  // Browser media elements report fractional seconds, while the database
  // stores this value as an integer. Round up so quota accounting never
  // under-counts a partial source-video minute and Postgres never receives a
  // value such as `272.266` for an integer column.
  source_duration_seconds: z.number().finite().positive().max(24 * 60 * 60)
    .transform((seconds) => Math.max(1, Math.ceil(seconds)))
    .optional(),
});

export const analyzeSchema = z.object({
  project_id: z.string().uuid(),
});

export const exportSchema = z.object({
  project_id: z.string().uuid(),
  candidate_ids: z.array(z.string().uuid()).min(1),
});
