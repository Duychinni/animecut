create extension if not exists "pgcrypto";

create table if not exists public.projects (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null,
  title text not null,
  source_type text not null check (source_type in ('upload','youtube')),
  source_url text,
  source_storage_path text,
  status text not null default 'created' check (status in ('created','transcribed','analyzed','exported','error')),
  duration_sec integer,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.transcripts (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  language text,
  full_text text not null,
  segments_json jsonb,
  created_at timestamptz not null default now()
);

create table if not exists public.clip_candidates (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  start_sec numeric not null,
  end_sec numeric not null,
  title text not null,
  reason text not null,
  hook_strength int not null check (hook_strength between 1 and 10),
  emotional_intensity int not null check (emotional_intensity between 1 and 10),
  clarity_without_context int not null check (clarity_without_context between 1 and 10),
  rewatch_potential int not null check (rewatch_potential between 1 and 10),
  overall_score numeric not null,
  rank int,
  created_at timestamptz not null default now()
);

create table if not exists public.exports (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  clip_candidate_id uuid not null references public.clip_candidates(id) on delete cascade,
  status text not null default 'queued' check (status in ('queued','processing','done','error')),
  output_storage_path text,
  error_message text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.jobs (
  id uuid primary key default gen_random_uuid(),
  project_id uuid references public.projects(id) on delete cascade,
  type text not null check (type in ('transcribe','analyze','export')),
  payload jsonb,
  status text not null default 'queued' check (status in ('queued','processing','done','error')),
  attempts int not null default 0,
  run_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
