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
  captionMaxWords: number;
  captionWordHighlight: boolean;
};

export const DEFAULT_CAPTION_PRESET_ID = 'opus-clean';

export const CAPTION_PRESETS: CaptionPreset[] = [
  {
    id: DEFAULT_CAPTION_PRESET_ID,
    name: 'Clean Pro',
    caption_template: 'capcut',
    caption_font: 'montserrat',
    captionFontFamily: 'Montserrat',
    captionFontSize: 12,
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
    name: 'Gold Focus',
    caption_template: 'capcut',
    caption_font: 'montserrat',
    captionFontFamily: 'Montserrat',
    captionFontSize: 12,
    captionTextColor: '#FFFFFF',
    captionHighlightColor: '#FFD84D',
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
    id: 'creator-glow',
    name: 'Pink Focus',
    caption_template: 'capcut',
    caption_font: 'montserrat',
    captionFontFamily: 'Montserrat',
    captionFontSize: 12,
    captionTextColor: '#FFFFFF',
    captionHighlightColor: '#FF4FD8',
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
    id: 'podcast-pro',
    name: 'Cyan Focus',
    caption_template: 'capcut',
    caption_font: 'montserrat',
    captionFontFamily: 'Montserrat',
    captionFontSize: 12,
    captionTextColor: '#FFFFFF',
    captionHighlightColor: '#5DE4FF',
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
    id: 'impact-yellow',
    name: 'Red Impact',
    caption_template: 'capcut',
    caption_font: 'montserrat',
    captionFontFamily: 'Montserrat',
    captionFontSize: 12,
    captionTextColor: '#FFFFFF',
    captionHighlightColor: '#FF3B30',
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
    id: 'clean-box',
    name: 'Blue Focus',
    caption_template: 'capcut',
    caption_font: 'montserrat',
    captionFontFamily: 'Montserrat',
    captionFontSize: 12,
    captionTextColor: '#FFFFFF',
    captionHighlightColor: '#4D8DFF',
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
    id: 'neon-pop',
    name: 'Purple Focus',
    caption_template: 'capcut',
    caption_font: 'montserrat',
    captionFontFamily: 'Montserrat',
    captionFontSize: 12,
    captionTextColor: '#FFFFFF',
    captionHighlightColor: '#A855F7',
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
    id: 'minimal-pro',
    name: 'Orange Focus',
    caption_template: 'capcut',
    caption_font: 'montserrat',
    captionFontFamily: 'Montserrat',
    captionFontSize: 12,
    captionTextColor: '#FFFFFF',
    captionHighlightColor: '#FF8A00',
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
    id: 'big-hook',
    name: 'Lime Focus',
    caption_template: 'capcut',
    caption_font: 'montserrat',
    captionFontFamily: 'Montserrat',
    captionFontSize: 12,
    captionTextColor: '#FFFFFF',
    captionHighlightColor: '#B7F34A',
    captionStrokeColor: '#000000',
    captionStrokeWidth: 6,
    captionShadow: 'black-heavy',
    captionBackgroundBox: false,
    captionPosition: 'lower-third',
    captionAnimation: 'word-highlight',
    captionMaxWords: 2,
    captionWordHighlight: true,
  },
];

export function getCaptionPresetById(id: string | null | undefined) {
  return CAPTION_PRESETS.find((preset) => preset.id === id) ?? CAPTION_PRESETS[0];
}
