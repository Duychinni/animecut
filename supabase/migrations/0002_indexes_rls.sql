create index if not exists idx_projects_user_id on public.projects(user_id);
create index if not exists idx_transcripts_project_id on public.transcripts(project_id);
create index if not exists idx_candidates_project_id on public.clip_candidates(project_id);
create index if not exists idx_exports_project_id on public.exports(project_id);
create index if not exists idx_jobs_status_run_at on public.jobs(status, run_at);

alter table public.projects enable row level security;
alter table public.transcripts enable row level security;
alter table public.clip_candidates enable row level security;
alter table public.exports enable row level security;
alter table public.jobs enable row level security;

create policy "projects owner"
  on public.projects
  for all
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

create policy "transcripts owner via project"
  on public.transcripts
  for all
  using (
    exists (
      select 1 from public.projects p
      where p.id = project_id and p.user_id = auth.uid()
    )
  )
  with check (
    exists (
      select 1 from public.projects p
      where p.id = project_id and p.user_id = auth.uid()
    )
  );

create policy "candidates owner via project"
  on public.clip_candidates
  for all
  using (
    exists (
      select 1 from public.projects p
      where p.id = project_id and p.user_id = auth.uid()
    )
  )
  with check (
    exists (
      select 1 from public.projects p
      where p.id = project_id and p.user_id = auth.uid()
    )
  );

create policy "exports owner via project"
  on public.exports
  for all
  using (
    exists (
      select 1 from public.projects p
      where p.id = project_id and p.user_id = auth.uid()
    )
  )
  with check (
    exists (
      select 1 from public.projects p
      where p.id = project_id and p.user_id = auth.uid()
    )
  );

create policy "jobs owner via project"
  on public.jobs
  for all
  using (
    project_id is null or exists (
      select 1 from public.projects p
      where p.id = project_id and p.user_id = auth.uid()
    )
  )
  with check (
    project_id is null or exists (
      select 1 from public.projects p
      where p.id = project_id and p.user_id = auth.uid()
    )
  );
