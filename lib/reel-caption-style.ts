export const DEFAULT_REEL_CAPTION_ACCENTS = ['#21F45A', '#FFFF00'] as const;
export type DefaultReelHookPlacement = 'top';

function stableHash(value: string) {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

/**
 * Split the default look evenly between green and bright yellow keyword
 * accents. The choice is stable across rerenders,
 * so it feels curated instead of changing randomly whenever a job retries.
 */
export function resolveDefaultReelCaptionAccent(seed: string) {
  return stableHash(seed || 'reel') % 2 === 0
    ? DEFAULT_REEL_CAPTION_ACCENTS[1]
    : DEFAULT_REEL_CAPTION_ACCENTS[0];
}

/** Keep generated hook cards in their original top-of-frame position. */
export function resolveDefaultReelHookPlacement(seed: string): DefaultReelHookPlacement {
  void seed;
  return 'top';
}
