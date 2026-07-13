import { z } from 'zod';

export const createProjectSchema = z.object({
  title: z.string().min(2),
  source_type: z.enum(['upload', 'youtube']),
  source_url: z.string().url().optional(),
  source_duration_seconds: z.number().positive().max(24 * 60 * 60).optional(),
});

export const analyzeSchema = z.object({
  project_id: z.string().uuid(),
});

export const exportSchema = z.object({
  project_id: z.string().uuid(),
  candidate_ids: z.array(z.string().uuid()).min(1),
});
