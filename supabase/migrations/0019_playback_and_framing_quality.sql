alter table public.exports
  add column if not exists preview_storage_provider text,
  add column if not exists preview_360_storage_path text,
  add column if not exists preview_540_storage_path text,
  add column if not exists preview_360_size_bytes bigint,
  add column if not exists preview_540_size_bytes bigint;

alter table public.exports
  drop constraint if exists exports_preview_storage_provider_check;

alter table public.exports
  add constraint exports_preview_storage_provider_check
  check (preview_storage_provider is null or preview_storage_provider in ('r2', 'supabase'));

create table if not exists public.playback_sessions (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null,
  user_id uuid not null references auth.users(id) on delete cascade,
  export_id uuid not null references public.exports(id) on delete cascade,
  preview_quality text check (preview_quality in ('master', '360p', '540p')),
  startup_ms integer check (startup_ms is null or startup_ms between 0 and 600000),
  buffering_count integer not null default 0 check (buffering_count between 0 and 10000),
  failed boolean not null default false,
  error_code text,
  connection_type text,
  effective_type text,
  downlink_mbps numeric,
  clip_size_bytes bigint,
  user_agent text,
  metadata jsonb not null default '{}'::jsonb,
  started_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, export_id, session_id)
);

create index if not exists playback_sessions_export_created_idx
  on public.playback_sessions(export_id, started_at desc);
create index if not exists playback_sessions_user_created_idx
  on public.playback_sessions(user_id, started_at desc);

create table if not exists public.framing_feedback (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  project_id uuid not null references public.projects(id) on delete cascade,
  export_id uuid not null references public.exports(id) on delete cascade,
  rating text not null check (rating in ('good', 'needs_adjustment')),
  issue_type text check (issue_type is null or issue_type in ('wrong_speaker', 'subject_cut_off', 'bad_split', 'too_much_motion', 'missed_context', 'other')),
  playhead_seconds numeric,
  correction jsonb,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists framing_feedback_export_created_idx
  on public.framing_feedback(export_id, created_at desc);
create index if not exists framing_feedback_issue_created_idx
  on public.framing_feedback(issue_type, created_at desc);

alter table public.playback_sessions enable row level security;
alter table public.framing_feedback enable row level security;

do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'playback_sessions' and policyname = 'playback session owner read'
  ) then
    create policy "playback session owner read" on public.playback_sessions
      for select using (auth.uid() = user_id);
  end if;

  if not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'framing_feedback' and policyname = 'framing feedback owner read'
  ) then
    create policy "framing feedback owner read" on public.framing_feedback
      for select using (auth.uid() = user_id);
  end if;
end
$$;

