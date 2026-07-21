create table if not exists public.project_notifications (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  notification_type text not null check (notification_type in ('completed', 'failed')),
  recipient text not null,
  sent_at timestamptz not null default now(),
  unique (project_id, notification_type)
);

alter table public.project_notifications enable row level security;
