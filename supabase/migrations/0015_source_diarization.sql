-- Phase 1: source-level anonymous diarization. All objects are additive.

create table if not exists public.media_analysis_runs (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  source_sha256 text not null check (length(source_sha256) = 64),
  operating_mode text not null check (operating_mode in ('full', 'degraded', 'safe')),
  schema_version integer not null,
  diarization_provider text not null,
  diarization_model text not null,
  diarization_model_revision text not null,
  provider_version text,
  embedding_model text not null,
  embedding_model_revision text not null,
  status text not null check (status in ('processing', 'done', 'degraded', 'error')),
  device text,
  worker_commit_sha text,
  attempt_count integer not null default 1 check (attempt_count > 0),
  speaker_count integer not null default 0 check (speaker_count >= 0),
  turn_count integer not null default 0 check (turn_count >= 0),
  duration_sec numeric,
  diagnostics jsonb not null default '{}'::jsonb,
  error_category text,
  error_detail text,
  started_at timestamptz not null default now(),
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists media_analysis_runs_source_version_idx
  on public.media_analysis_runs(
    project_id,
    source_sha256,
    schema_version,
    diarization_provider,
    diarization_model,
    diarization_model_revision,
    embedding_model,
    embedding_model_revision
  );
create index if not exists media_analysis_runs_project_created_idx
  on public.media_analysis_runs(project_id, created_at desc);

create table if not exists public.source_speakers (
  id uuid primary key default gen_random_uuid(),
  analysis_run_id uuid not null references public.media_analysis_runs(id) on delete cascade,
  project_id uuid not null references public.projects(id) on delete cascade,
  speaker_key text not null check (speaker_key ~ '^speaker_[a-z]+$'),
  evidence_duration_sec numeric not null default 0 check (evidence_duration_sec >= 0),
  embedding_model text not null,
  embedding_model_revision text not null,
  embedding_dimension integer not null check (embedding_dimension > 0),
  created_at timestamptz not null default now(),
  unique (analysis_run_id, speaker_key)
);

create table if not exists public.speaker_turns (
  id uuid primary key default gen_random_uuid(),
  analysis_run_id uuid not null references public.media_analysis_runs(id) on delete cascade,
  project_id uuid not null references public.projects(id) on delete cascade,
  speaker_id uuid references public.source_speakers(id) on delete cascade,
  speaker_key text,
  start_sec numeric not null check (start_sec >= 0),
  end_sec numeric not null check (end_sec > start_sec),
  confidence numeric check (confidence is null or (confidence >= 0 and confidence <= 1)),
  confidence_source text,
  overlap boolean not null default false,
  classification text not null check (classification in ('speech', 'silence', 'music_or_broll', 'unknown')),
  created_at timestamptz not null default now(),
  check (
    (classification = 'speech' and speaker_id is not null and speaker_key is not null)
    or (classification <> 'speech' and speaker_id is null and speaker_key is null)
  )
);

create index if not exists speaker_turns_run_time_idx
  on public.speaker_turns(analysis_run_id, start_sec, end_sec);
create index if not exists speaker_turns_project_time_idx
  on public.speaker_turns(project_id, start_sec, end_sec);

-- Kept separate so browser-readable speaker metadata never contains a storage path.
create table if not exists public.speaker_embedding_artifacts (
  id uuid primary key default gen_random_uuid(),
  analysis_run_id uuid not null unique references public.media_analysis_runs(id) on delete cascade,
  project_id uuid not null references public.projects(id) on delete cascade,
  storage_path text not null unique,
  encryption_algorithm text not null check (encryption_algorithm = 'aes-256-gcm'),
  encryption_key_version text not null,
  expires_at timestamptz not null,
  deleted_at timestamptz,
  created_at timestamptz not null default now()
);

create index if not exists speaker_embedding_artifacts_expiry_idx
  on public.speaker_embedding_artifacts(expires_at)
  where deleted_at is null;

alter table public.media_analysis_runs enable row level security;
alter table public.source_speakers enable row level security;
alter table public.speaker_turns enable row level security;
alter table public.speaker_embedding_artifacts enable row level security;

do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'media_analysis_runs' and policyname = 'analysis runs owner read'
  ) then
    create policy "analysis runs owner read" on public.media_analysis_runs
      for select using (
        exists (select 1 from public.projects p where p.id = project_id and p.user_id = auth.uid())
      );
  end if;

  if not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'source_speakers' and policyname = 'source speakers owner read'
  ) then
    create policy "source speakers owner read" on public.source_speakers
      for select using (
        exists (select 1 from public.projects p where p.id = project_id and p.user_id = auth.uid())
      );
  end if;

  if not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'speaker_turns' and policyname = 'speaker turns owner read'
  ) then
    create policy "speaker turns owner read" on public.speaker_turns
      for select using (
        exists (select 1 from public.projects p where p.id = project_id and p.user_id = auth.uid())
      );
  end if;

  -- Intentionally no authenticated-client policy for speaker_embedding_artifacts.
  -- Only the service-role worker can read/write embedding object metadata.
end $$;

insert into storage.buckets (id, name, public)
values ('analysis-artifacts', 'analysis-artifacts', false)
on conflict (id) do update set public = false;

comment on table public.speaker_embedding_artifacts is
  'Server-only encrypted source-local embeddings. Never use for cross-project or real-person identification.';
