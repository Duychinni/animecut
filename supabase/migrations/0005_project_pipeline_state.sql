alter table public.projects
  add column if not exists pipeline_status text not null default 'idle'
    check (pipeline_status in ('idle', 'queued', 'processing', 'completed', 'error')),
  add column if not exists pipeline_error text,
  add column if not exists pipeline_started_at timestamptz,
  add column if not exists pipeline_completed_at timestamptz;

alter table public.jobs
  drop constraint if exists jobs_type_check;

alter table public.jobs
  add constraint jobs_type_check check (type in ('pipeline','transcribe','analyze','export'));

create index if not exists jobs_type_status_run_at_idx
  on public.jobs(type, status, run_at);

create index if not exists projects_pipeline_status_idx
  on public.projects(pipeline_status, updated_at desc);
