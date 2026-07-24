alter table public.clip_candidates
  add column if not exists component_scores jsonb,
  add column if not exists technical_metrics jsonb,
  add column if not exists score_penalties jsonb,
  add column if not exists score_label text,
  add column if not exists score_confidence numeric,
  add column if not exists score_reasons jsonb;

notify pgrst, 'reload schema';
