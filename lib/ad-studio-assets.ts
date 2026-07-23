export const AD_ASSET_CATEGORIES = [
  'product-demo',
  'talking-head',
  'finished-reel',
  'before-after',
  'b-roll',
] as const;

export type AdAssetCategory = (typeof AD_ASSET_CATEGORIES)[number];

export const AD_ASSET_CATEGORY_LABELS: Record<AdAssetCategory, string> = {
  'product-demo': 'Product demo',
  'talking-head': 'Talking head',
  'finished-reel': 'Finished reel',
  'before-after': 'Before / after',
  'b-roll': 'B-roll',
};

export type AdAsset = {
  id: string;
  path: string;
  name: string;
  category: AdAssetCategory;
  contentType: string;
  size: number;
  createdAt: string | null;
  previewUrl: string;
};

export function isAdAssetCategory(value: string): value is AdAssetCategory {
  return AD_ASSET_CATEGORIES.includes(value as AdAssetCategory);
}
