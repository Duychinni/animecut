alter table public.profiles
  add column if not exists free_uploads_remaining integer not null default 1;

alter table public.profiles
  drop constraint if exists profiles_free_uploads_remaining_check;

alter table public.profiles
  add constraint profiles_free_uploads_remaining_check
  check (free_uploads_remaining >= 0);

comment on column public.profiles.free_uploads_remaining is
  'Number of login-required free trial source videos the account can still process.';
