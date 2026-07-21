alter table public.exports
  add column if not exists caption_edit_preview_provider text,
  add column if not exists caption_edit_preview_storage_path text;

comment on column public.exports.caption_edit_preview_storage_path is
  'Caption-free, fully framed reel preview used as the editable canvas in caption tools.';
