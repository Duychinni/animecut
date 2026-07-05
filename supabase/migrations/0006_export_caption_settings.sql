alter table public.exports
  add column if not exists caption_preset_id text,
  add column if not exists caption_font_family text,
  add column if not exists caption_font_size integer,
  add column if not exists caption_text_color text,
  add column if not exists caption_highlight_color text,
  add column if not exists caption_stroke_color text,
  add column if not exists caption_stroke_width integer,
  add column if not exists caption_shadow text,
  add column if not exists caption_background_box boolean,
  add column if not exists caption_position text,
  add column if not exists caption_animation text;
