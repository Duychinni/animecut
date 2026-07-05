alter table public.projects
  add column if not exists source_platform text,
  add column if not exists source_video_id text,
  add column if not exists source_title text,
  add column if not exists source_thumbnail_url text,
  add column if not exists source_channel_name text,
  add column if not exists source_duration_seconds integer;
