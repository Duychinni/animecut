-- Reassert quality-critical columns. This is intentionally idempotent because
-- an early production schema was marked through 0010 while its API cache did
-- not expose hook_text.
alter table public.clip_candidates
  add column if not exists hook_text text,
  add column if not exists editorial_plan jsonb;

notify pgrst, 'reload schema';
