const CANONICAL_NAMES: Array<[RegExp, string]> = [
  [/\bmr\.?\s*beast\b/i, 'MrBeast'],
];

export function canonicalizeKnownNames(value: string) {
  return CANONICAL_NAMES.reduce(
    (text, [pattern, canonical]) => text.replace(new RegExp(pattern.source, pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`), canonical),
    value,
  );
}

export function verifiedSourceSubjectHint(sourceTitle: string | null | undefined) {
  const title = canonicalizeKnownNames(String(sourceTitle ?? '').trim());
  const known = CANONICAL_NAMES.map(([, canonical]) => canonical).find((name) => title.toLowerCase().includes(name.toLowerCase()));
  if (!known) return '';
  return `Verified central subject: ${known}. Use this exact familiar name in titles and hooks when the clip discusses their story; do not replace it with vague words such as he, creator, or YouTuber.`;
}
