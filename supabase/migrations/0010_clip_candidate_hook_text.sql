alter table public.clip_candidates
  add column if not exists hook_text text;
