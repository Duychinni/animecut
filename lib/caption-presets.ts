export type CaptionTemplate = 'clean' | 'bold' | 'viral' | 'karaoke' | 'cinematic' | 'rage' | 'minimal' | 'capcut';
export type CaptionFont = 'arial' | 'montserrat' | 'impact' | 'bangers' | 'anton' | 'bebas' | 'poppins';

export const CAPTION_FONTS: Array<{ id: CaptionFont; name: string; family: string }> = [
  { id: 'poppins', name: 'Poppins', family: 'Poppins ExtraBold' },
  { id: 'montserrat', name: 'Montserrat', family: 'Montserrat' },
  { id: 'anton', name: 'Anton', family: 'Anton' },
  { id: 'bangers', name: 'Bangers', family: 'Bangers' },
  { id: 'arial', name: 'Arial', family: 'Arial' },
];

export function getCaptionFontById(id: string | null | undefined) {
  return CAPTION_FONTS.find((font) => font.id === id) ?? CAPTION_FONTS[0];
}

export type CaptionPreset = {
  id: string;
  name: string;
  caption_template: CaptionTemplate;
  caption_font: CaptionFont;
  captionFontFamily: string;
  captionFontSize: number;
  captionTextColor: string;
  captionHighlightColor: string;
  captionStrokeColor: string;
  captionStrokeWidth: number;
  captionShadow: string;
  captionBackgroundBox: boolean;
  captionPosition: string;
  captionAnimation: string;
  captionMaxWords: number;
  captionWordHighlight: boolean;
};

export const DEFAULT_CAPTION_PRESET_ID = 'opus-clean';

export const CAPTION_PRESETS: CaptionPreset[] = [
  {
    id: DEFAULT_CAPTION_PRESET_ID,
    name: 'Clean Pro',
    caption_template: 'capcut',
    caption_font: 'poppins',
    captionFontFamily: 'Poppins ExtraBold',
    captionFontSize: 13,
    captionTextColor: '#FFFFFF',
    captionHighlightColor: '#21F45A',
    captionStrokeColor: '#000000',
    captionStrokeWidth: 6,
    captionShadow: 'black-heavy',
    captionBackgroundBox: false,
    captionPosition: 'lower-third',
    captionAnimation: 'word-highlight',
    captionMaxWords: 2,
    captionWordHighlight: true,
  },
  {
    id: 'viral-bold',
    name: 'Hormozi',
    caption_template: 'viral',
    caption_font: 'montserrat',
    captionFontFamily: 'Montserrat',
    captionFontSize: 14,
    captionTextColor: '#FFFFFF',
    captionHighlightColor: '#FFFF00',
    captionStrokeColor: '#000000',
    captionStrokeWidth: 7,
    captionShadow: 'yellow-glow',
    captionBackgroundBox: false,
    captionPosition: 'lower-third',
    captionAnimation: 'word-highlight',
    captionMaxWords: 3,
    captionWordHighlight: true,
  },
  {
    id: 'creator-glow',
    name: 'Karaoke Pop',
    caption_template: 'karaoke',
    caption_font: 'bangers',
    captionFontFamily: 'Bangers',
    captionFontSize: 12,
    captionTextColor: '#FFFFFF',
    captionHighlightColor: '#FF4FD8',
    captionStrokeColor: '#000000',
    captionStrokeWidth: 5,
    captionShadow: 'neon-glow',
    captionBackgroundBox: false,
    captionPosition: 'lower-third',
    captionAnimation: 'word-highlight',
    captionMaxWords: 4,
    captionWordHighlight: true,
  },
  {
    id: 'podcast-pro',
    name: 'Podcast',
    caption_template: 'clean',
    caption_font: 'poppins',
    captionFontFamily: 'Poppins ExtraBold',
    captionFontSize: 12,
    captionTextColor: '#FFFFFF',
    captionHighlightColor: '#5DE4FF',
    captionStrokeColor: '#000000',
    captionStrokeWidth: 4,
    captionShadow: 'soft-glow',
    captionBackgroundBox: false,
    captionPosition: 'lower-third',
    captionAnimation: 'word-highlight',
    captionMaxWords: 4,
    captionWordHighlight: true,
  },
  {
    id: 'impact-yellow',
    name: 'Impact',
    caption_template: 'rage',
    caption_font: 'anton',
    captionFontFamily: 'Anton',
    captionFontSize: 15,
    captionTextColor: '#FFFFFF',
    captionHighlightColor: '#FF3B30',
    captionStrokeColor: '#000000',
    captionStrokeWidth: 8,
    captionShadow: 'red-pop',
    captionBackgroundBox: false,
    captionPosition: 'lower-third',
    captionAnimation: 'word-highlight',
    captionMaxWords: 2,
    captionWordHighlight: true,
  },
  {
    id: 'clean-box',
    name: 'Clean Box',
    caption_template: 'clean',
    caption_font: 'montserrat',
    captionFontFamily: 'Montserrat',
    captionFontSize: 11,
    captionTextColor: '#111111',
    captionHighlightColor: '#4D8DFF',
    captionStrokeColor: '#000000',
    captionStrokeWidth: 0,
    captionShadow: 'subtle-shadow',
    captionBackgroundBox: true,
    captionPosition: 'lower-third',
    captionAnimation: 'word-highlight',
    captionMaxWords: 4,
    captionWordHighlight: true,
  },
  {
    id: 'neon-pop',
    name: 'Neon',
    caption_template: 'bold',
    caption_font: 'poppins',
    captionFontFamily: 'Poppins ExtraBold',
    captionFontSize: 12,
    captionTextColor: '#FFFFFF',
    captionHighlightColor: '#A855F7',
    captionStrokeColor: '#000000',
    captionStrokeWidth: 4,
    captionShadow: 'purple-glow',
    captionBackgroundBox: false,
    captionPosition: 'lower-third',
    captionAnimation: 'word-highlight',
    captionMaxWords: 3,
    captionWordHighlight: true,
  },
  {
    id: 'minimal-pro',
    name: 'Minimal',
    caption_template: 'minimal',
    caption_font: 'montserrat',
    captionFontFamily: 'Montserrat',
    captionFontSize: 10,
    captionTextColor: '#FFFFFF',
    captionHighlightColor: '#FF8A00',
    captionStrokeColor: '#000000',
    captionStrokeWidth: 2,
    captionShadow: 'subtle-shadow',
    captionBackgroundBox: false,
    captionPosition: 'lower-third',
    captionAnimation: 'word-highlight',
    captionMaxWords: 2,
    captionWordHighlight: false,
  },
  {
    id: 'big-hook',
    name: 'Big Hook',
    caption_template: 'bold',
    caption_font: 'anton',
    captionFontFamily: 'Anton',
    captionFontSize: 17,
    captionTextColor: '#FFFFFF',
    captionHighlightColor: '#B7F34A',
    captionStrokeColor: '#000000',
    captionStrokeWidth: 8,
    captionShadow: 'heavy-shadow',
    captionBackgroundBox: false,
    captionPosition: 'center',
    captionAnimation: 'word-highlight',
    captionMaxWords: 3,
    captionWordHighlight: true,
  },
];

export function getCaptionPresetById(id: string | null | undefined) {
  return CAPTION_PRESETS.find((preset) => preset.id === id) ?? CAPTION_PRESETS[0];
}
