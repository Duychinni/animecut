alter table public.exports
  add column if not exists hook_text_enabled boolean not null default true,
  add column if not exists hook_text text;
