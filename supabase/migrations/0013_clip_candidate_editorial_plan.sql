alter table public.clip_candidates
  add column if not exists editorial_plan jsonb not null default '{}'::jsonb;
