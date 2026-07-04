insert into storage.buckets (id, name, public)
values ('raw-media', 'raw-media', false)
on conflict (id) do nothing;

insert into storage.buckets (id, name, public)
values ('exports', 'exports', false)
on conflict (id) do nothing;

do $$
begin
  if not exists (select 1 from pg_policies where schemaname = 'storage' and tablename = 'objects' and policyname = 'raw media owner read') then
    create policy "raw media owner read"
    on storage.objects for select
    using (
      bucket_id = 'raw-media'
      and auth.uid()::text = (storage.foldername(name))[1]
    );
  end if;

  if not exists (select 1 from pg_policies where schemaname = 'storage' and tablename = 'objects' and policyname = 'raw media owner write') then
    create policy "raw media owner write"
    on storage.objects for insert
    with check (
      bucket_id = 'raw-media'
      and auth.uid()::text = (storage.foldername(name))[1]
    );
  end if;

  if not exists (select 1 from pg_policies where schemaname = 'storage' and tablename = 'objects' and policyname = 'raw media owner update') then
    create policy "raw media owner update"
    on storage.objects for update
    using (
      bucket_id = 'raw-media'
      and auth.uid()::text = (storage.foldername(name))[1]
    )
    with check (
      bucket_id = 'raw-media'
      and auth.uid()::text = (storage.foldername(name))[1]
    );
  end if;

  if not exists (select 1 from pg_policies where schemaname = 'storage' and tablename = 'objects' and policyname = 'exports owner read') then
    create policy "exports owner read"
    on storage.objects for select
    using (
      bucket_id = 'exports'
      and auth.uid()::text = (storage.foldername(name))[1]
    );
  end if;

  if not exists (select 1 from pg_policies where schemaname = 'storage' and tablename = 'objects' and policyname = 'exports owner write') then
    create policy "exports owner write"
    on storage.objects for insert
    with check (
      bucket_id = 'exports'
      and auth.uid()::text = (storage.foldername(name))[1]
    );
  end if;

  if not exists (select 1 from pg_policies where schemaname = 'storage' and tablename = 'objects' and policyname = 'exports owner update') then
    create policy "exports owner update"
    on storage.objects for update
    using (
      bucket_id = 'exports'
      and auth.uid()::text = (storage.foldername(name))[1]
    )
    with check (
      bucket_id = 'exports'
      and auth.uid()::text = (storage.foldername(name))[1]
    );
  end if;
end $$;
