-- Source videos are uploaded directly from the browser to Storage. Existing
-- projects may still have the small dashboard-created bucket limit even after
-- the application code is redeployed, so reconcile the bucket explicitly.
--
-- 5 GiB is the application's configured ceiling for direct signed uploads.
-- Production installations that need larger or more resilient uploads should use the existing R2
-- multipart provider instead of proxying media through the Next.js application.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('raw-media', 'raw-media', false, 5368709120, null)
on conflict (id) do update
set
  public = excluded.public,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;
