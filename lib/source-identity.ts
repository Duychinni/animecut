const CANONICAL_NAMES: Array<[RegExp, string]> = [
  [/\bmr\.?\s*beast\b/i, 'MrBeast'],
  [/\bjoe\s+rogan\b/i, 'Joe Rogan'],
  [/\blogan\s+paul\b/i, 'Logan Paul'],
  [/\bi\s*show\s*speed\b/i, 'IShowSpeed'],
];

export function canonicalizeKnownNames(value: string) {
  return CANONICAL_NAMES.reduce(
    (text, [pattern, canonical]) => text.replace(new RegExp(pattern.source, pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`), canonical),
    value,
  );
}

export function verifiedSourceSubjectHint(sourceTitle: string | null | undefined) {
  const title = canonicalizeKnownNames(String(sourceTitle ?? '').trim());
  const known = CANONICAL_NAMES
    .map(([, canonical]) => canonical)
    .filter((name) => title.toLowerCase().includes(name.toLowerCase()));
  if (!known.length) return '';
  return `Verified recognizable figures in source metadata: ${known.join(', ')}. Their names are available for accurate editorial copy, but use a name only when that person is central to the specific clip and the name materially improves clarity, search value, or curiosity. Across a reel set, deliberately mix named and topic-led titles/hooks; never repeat a celebrity name mechanically in every reel or in both the title and hook without a strong reason.`;
}
