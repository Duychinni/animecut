alter table public.exports
  add column if not exists clip_edit_settings jsonb not null default '{}'::jsonb,
  add column if not exists edit_status text not null default 'idle';

alter table public.exports
  drop constraint if exists exports_edit_status_check;

alter table public.exports
  add constraint exports_edit_status_check
  check (edit_status in ('idle', 'draft', 'rendering', 'rendered', 'error'));

create index if not exists exports_project_status_updated_idx
  on public.exports(project_id, status, updated_at desc);

create index if not exists exports_project_edit_status_idx
  on public.exports(project_id, edit_status, updated_at desc);

create index if not exists exports_clip_candidate_id_idx
  on public.exports(clip_candidate_id);

create index if not exists jobs_queue_fast_idx
  on public.jobs(status, run_at, updated_at)
  where status in ('queued', 'processing');

create index if not exists projects_user_updated_idx
  on public.projects(user_id, updated_at desc);

create index if not exists candidates_project_rank_score_idx
  on public.clip_candidates(project_id, rank, overall_score desc);
