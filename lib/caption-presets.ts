export type CaptionTemplate = 'clean' | 'bold' | 'viral' | 'karaoke' | 'cinematic' | 'rage' | 'minimal' | 'capcut';
export type CaptionFont = 'arial' | 'montserrat' | 'impact' | 'bangers' | 'anton' | 'bebas' | 'poppins';

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
};

export const DEFAULT_CAPTION_PRESET_ID = 'opus-clean';

export const CAPTION_PRESETS: CaptionPreset[] = [
  {
    id: DEFAULT_CAPTION_PRESET_ID,
    name: 'Auto Hook Clean',
    caption_template: 'capcut',
    caption_font: 'arial',
    captionFontFamily: 'Arial Black',
    captionFontSize: 12,
    captionTextColor: '#FFFFFF',
    captionHighlightColor: '#21F45A',
    captionStrokeColor: '#000000',
    captionStrokeWidth: 6,
    captionShadow: 'black-heavy',
    captionBackgroundBox: false,
    captionPosition: 'lower-third',
    captionAnimation: 'word-highlight',
  },
  {
    id: 'viral-bold',
    name: 'Viral Bold',
    caption_template: 'bold',
    caption_font: 'arial',
    captionFontFamily: 'Arial Black',
    captionFontSize: 12,
    captionTextColor: '#FFFFFF',
    captionHighlightColor: '#FFD84D',
    captionStrokeColor: '#000000',
    captionStrokeWidth: 5,
    captionShadow: 'black-heavy',
    captionBackgroundBox: false,
    captionPosition: 'lower-third',
    captionAnimation: 'word-highlight',
  },
  {
    id: 'creator-glow',
    name: 'Creator Glow',
    caption_template: 'viral',
    caption_font: 'poppins',
    captionFontFamily: 'Poppins ExtraBold',
    captionFontSize: 11,
    captionTextColor: '#FFFFFF',
    captionHighlightColor: '#FF58C7',
    captionStrokeColor: '#140014',
    captionStrokeWidth: 3,
    captionShadow: 'neon-glow',
    captionBackgroundBox: false,
    captionPosition: 'lower-third',
    captionAnimation: 'word-highlight',
  },
  {
    id: 'podcast-pro',
    name: 'Podcast Pro',
    caption_template: 'clean',
    caption_font: 'arial',
    captionFontFamily: 'Inter ExtraBold',
    captionFontSize: 10,
    captionTextColor: '#FFFFFF',
    captionHighlightColor: '#5DE4FF',
    captionStrokeColor: '#000000',
    captionStrokeWidth: 2,
    captionShadow: 'clean-shadow',
    captionBackgroundBox: false,
    captionPosition: 'lower-third',
    captionAnimation: 'word-highlight',
  },
  {
    id: 'impact-yellow',
    name: 'Impact Yellow',
    caption_template: 'rage',
    caption_font: 'anton',
    captionFontFamily: 'Anton',
    captionFontSize: 13,
    captionTextColor: '#FFD84D',
    captionHighlightColor: '#FFFFFF',
    captionStrokeColor: '#000000',
    captionStrokeWidth: 5,
    captionShadow: 'heavy-shadow',
    captionBackgroundBox: false,
    captionPosition: 'lower-third',
    captionAnimation: 'word-highlight',
  },
  {
    id: 'clean-box',
    name: 'Clean Box',
    caption_template: 'capcut',
    caption_font: 'arial',
    captionFontFamily: 'Inter Bold',
    captionFontSize: 10,
    captionTextColor: '#FFFFFF',
    captionHighlightColor: '#61F29B',
    captionStrokeColor: '#000000',
    captionStrokeWidth: 2,
    captionShadow: 'subtle-shadow',
    captionBackgroundBox: true,
    captionPosition: 'lower-third',
    captionAnimation: 'word-highlight',
  },
  {
    id: 'neon-pop',
    name: 'Neon Pop',
    caption_template: 'viral',
    caption_font: 'poppins',
    captionFontFamily: 'Poppins Black',
    captionFontSize: 11,
    captionTextColor: '#FFFFFF',
    captionHighlightColor: '#FF4FD8',
    captionStrokeColor: '#6C2BFF',
    captionStrokeWidth: 3,
    captionShadow: 'purple-glow',
    captionBackgroundBox: false,
    captionPosition: 'lower-third',
    captionAnimation: 'scale-pop',
  },
  {
    id: 'minimal-pro',
    name: 'Minimal Pro',
    caption_template: 'minimal',
    caption_font: 'arial',
    captionFontFamily: 'Inter SemiBold',
    captionFontSize: 9,
    captionTextColor: '#FFFFFF',
    captionHighlightColor: '#FFFFFF',
    captionStrokeColor: '#111111',
    captionStrokeWidth: 1,
    captionShadow: 'subtle-shadow',
    captionBackgroundBox: false,
    captionPosition: 'lower-third',
    captionAnimation: 'none',
  },
  {
    id: 'big-hook',
    name: 'Big Hook',
    caption_template: 'rage',
    caption_font: 'montserrat',
    captionFontFamily: 'Montserrat Black',
    captionFontSize: 14,
    captionTextColor: '#FFFFFF',
    captionHighlightColor: '#FF9A36',
    captionStrokeColor: '#000000',
    captionStrokeWidth: 5,
    captionShadow: 'heavy-shadow',
    captionBackgroundBox: false,
    captionPosition: 'lower-third',
    captionAnimation: 'scale-pop',
  },
];

export function getCaptionPresetById(id: string | null | undefined) {
  return CAPTION_PRESETS.find((preset) => preset.id === id) ?? CAPTION_PRESETS[0];
}
