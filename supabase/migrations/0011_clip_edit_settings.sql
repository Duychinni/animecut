alter table public.exports
  add column if not exists clip_edit_settings jsonb not null default '{}'::jsonb,
  add column if not exists edit_status text not null default 'idle';

create index if not exists exports_edit_status_idx on public.exports(edit_status);
