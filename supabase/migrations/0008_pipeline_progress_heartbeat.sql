alter table public.projects
  add column if not exists pipeline_stage text,
  add column if not exists pipeline_stage_label text,
  add column if not exists pipeline_progress_percent integer,
  add column if not exists worker_started_at timestamptz,
  add column if not exists worker_last_seen_at timestamptz,
  add column if not exists worker_last_log_message text;

create index if not exists projects_pipeline_progress_idx
  on public.projects(pipeline_status, pipeline_stage, updated_at desc);
