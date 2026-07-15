-- Backward-compatible reconciliation for objects already used by application code.
-- This migration is additive and idempotent. It does not recreate populated tables.

create extension if not exists "pgcrypto";

create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  stripe_customer_id text,
  stripe_subscription_id text,
  subscription_plan text not null default 'free',
  subscription_status text not null default 'inactive',
  subscription_interval text,
  subscription_ends_at timestamptz,
  current_period_end timestamptz,
  cancel_at_period_end boolean not null default false,
  processing_minutes_limit integer not null default 0,
  processing_minutes_used integer not null default 0,
  processing_minutes_remaining integer not null default 0,
  free_uploads_remaining integer not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.profiles
  add column if not exists stripe_customer_id text,
  add column if not exists stripe_subscription_id text,
  add column if not exists subscription_plan text not null default 'free',
  add column if not exists subscription_status text not null default 'inactive',
  add column if not exists subscription_interval text,
  add column if not exists subscription_ends_at timestamptz,
  add column if not exists current_period_end timestamptz,
  add column if not exists cancel_at_period_end boolean not null default false,
  add column if not exists processing_minutes_limit integer not null default 0,
  add column if not exists processing_minutes_used integer not null default 0,
  add column if not exists processing_minutes_remaining integer not null default 0,
  add column if not exists free_uploads_remaining integer not null default 1,
  add column if not exists created_at timestamptz not null default now(),
  add column if not exists updated_at timestamptz not null default now();

create unique index if not exists profiles_stripe_customer_id_idx
  on public.profiles(stripe_customer_id)
  where stripe_customer_id is not null;

create table if not exists public.usage_ledger (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  project_id uuid references public.projects(id) on delete set null,
  usage_type text not null,
  quantity numeric not null check (quantity >= 0),
  notes text,
  created_at timestamptz not null default now()
);

create index if not exists usage_ledger_user_created_idx
  on public.usage_ledger(user_id, created_at desc);
create index if not exists usage_ledger_project_idx
  on public.usage_ledger(project_id);

alter table public.profiles enable row level security;
alter table public.usage_ledger enable row level security;

do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'profiles' and policyname = 'profiles owner'
  ) then
    create policy "profiles owner" on public.profiles
      for select using (auth.uid() = id);
  end if;

  if not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'usage_ledger' and policyname = 'usage ledger owner'
  ) then
    create policy "usage ledger owner" on public.usage_ledger
      for select using (auth.uid() = user_id);
  end if;
end $$;

-- Preserve every status literal already accepted by the original constraint and
-- add completed. The common generated constraint name comes from 0001_init.sql.
do $$
declare
  current_definition text;
  allowed_values text[];
  value_list text;
begin
  select pg_get_constraintdef(oid)
    into current_definition
  from pg_constraint
  where conrelid = 'public.projects'::regclass
    and conname = 'projects_status_check'
    and contype = 'c';

  if current_definition is not null and current_definition not ilike '%completed%' then
    select array_agg(distinct captures[1])
      into allowed_values
    from regexp_matches(current_definition, '''([^'']+)''', 'g') as matched(captures);

    allowed_values := coalesce(allowed_values, array['created', 'transcribed', 'analyzed', 'exported', 'error']);
    if not ('completed' = any(allowed_values)) then
      allowed_values := array_append(allowed_values, 'completed');
    end if;

    select string_agg(quote_literal(value), ',') into value_list
    from unnest(allowed_values) as value;

    alter table public.projects drop constraint projects_status_check;
    execute format(
      'alter table public.projects add constraint projects_status_check check (status = any (array[%s]::text[]))',
      value_list
    );
  elsif current_definition is null then
    alter table public.projects
      add constraint projects_status_check
      check (status in ('created', 'transcribed', 'analyzed', 'exported', 'completed', 'error'));
  end if;
end $$;
