alter table public.exports
  add column if not exists render_source_width integer,
  add column if not exists render_source_height integer;

comment on column public.exports.render_source_width is
  'Source width used for the most recent successful full-quality master render.';

comment on column public.exports.render_source_height is
  'Source height used for the most recent successful full-quality master render.';

notify pgrst, 'reload schema';
