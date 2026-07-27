create table if not exists public.push_subscriptions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  endpoint text not null unique,
  p256dh text not null,
  auth text not null,
  user_agent text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists push_subscriptions_user_id_idx
  on public.push_subscriptions(user_id);

create table if not exists public.project_push_notifications (
  project_id uuid not null references public.projects(id) on delete cascade,
  subscription_id uuid not null references public.push_subscriptions(id) on delete cascade,
  notification_type text not null check (notification_type in ('completed', 'failed')),
  sent_at timestamptz not null default now(),
  primary key (project_id, subscription_id, notification_type)
);

alter table public.push_subscriptions enable row level security;
alter table public.project_push_notifications enable row level security;
