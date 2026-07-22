export const REEL_CAPTION_ACCENTS = ['#21F45A', '#FFD84D'] as const;

export type HookPlacement = 'top' | 'upper-middle';

function stableHash(value: string) {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

export function resolveReelCaptionAccent(seed: string) {
  return REEL_CAPTION_ACCENTS[stableHash(seed || 'reel') % REEL_CAPTION_ACCENTS.length];
}

function cleanEditorialValue(value: unknown) {
  return typeof value === 'string' ? value.trim().toLowerCase().replace(/[\s-]+/g, '_') : '';
}

/**
 * Keep hooks at the top when the shot needs its visual context preserved.
 * A restrained subset of straightforward talking-head shots can use the open
 * chest/torso area instead. The seed makes the choice stable across rerenders.
 */
export function resolveHookPlacement(
  seed: string,
  editorialPlan?: Record<string, unknown> | null,
): HookPlacement {
  const sceneType = cleanEditorialValue(editorialPlan?.scene_type);
  const layout = cleanEditorialValue(editorialPlan?.recommended_layout);
  const visualContextRequired = editorialPlan?.visual_context_required === true;
  const contextHeavy = visualContextRequired
    || /(screen|broll|b_roll|demo|product|wide|grid)/.test(sceneType)
    || /(split|stack|grid|wide|screen)/.test(layout);
  if (contextHeavy) return 'top';

  const talkingHead = !sceneType || /(talking|monologue|interview|podcast|speaker|conversation)/.test(sceneType);
  return talkingHead && stableHash(seed || 'reel') % 3 === 0 ? 'upper-middle' : 'top';
}
