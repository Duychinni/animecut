alter table public.projects
  add column if not exists content_rights_confirmed_at timestamptz;

comment on column public.projects.content_rights_confirmed_at is
  'Time the user confirmed ownership or permission to upload, process, and export the submitted content.';
