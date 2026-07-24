const CANONICAL_NAMES: Array<[RegExp, string]> = [
  [/\bmr\.?\s*beast\b/i, 'MrBeast'],
  [/\bjoe\s+rogan\b/i, 'Joe Rogan'],
  [/\bjimmy\s+fallon\b/i, 'Jimmy Fallon'],
  [/\blogan\s+paul\b/i, 'Logan Paul'],
  [/\bi\s*show\s*speed\b/i, 'IShowSpeed'],
  [/\bsteven?\s+seag[ae]l\b/i, 'Steven Seagal'],
];

export function canonicalizeKnownNames(value: string) {
  return CANONICAL_NAMES.reduce(
    (text, [pattern, canonical]) => text.replace(new RegExp(pattern.source, pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`), canonical),
    value,
  );
}

export function verifiedSourceSubjectHint(sourceTitle: string | null | undefined, sourceChannelName?: string | null) {
  const title = canonicalizeKnownNames(String(sourceTitle ?? '').trim());
  const channel = canonicalizeKnownNames(String(sourceChannelName ?? '').trim());
  const metadata = `${title} ${channel}`.trim();
  const known = CANONICAL_NAMES
    .map(([, canonical]) => canonical)
    .filter((name) => metadata.toLowerCase().includes(name.toLowerCase()));
  if (!known.length) return '';
  return `Verified recognizable figures in source metadata: ${known.join(', ')}. Their names are available for accurate editorial copy. When a verified figure is central to a specific clip, deliberately use the name in some of the strongest titles or hooks when it improves recognition, search value, curiosity, or virality. In an interview, the verified host may be named when their question, reaction, challenge, or exchange is part of the clip's payoff. Across a reel set, mix named and topic-led titles/hooks: avoid both omitting a highly relevant recognizable name from every clip and repeating it mechanically in every reel or in both the title and hook without a strong reason.`;
}

export function editorialSourceContext(input: {
  sourcePlatform?: string | null;
  sourceTitle?: string | null;
  projectTitle?: string | null;
  sourceChannelName?: string | null;
}) {
  // Upload titles are filenames, often camera timestamps. They are useful
  // labels, but never verified evidence for editorial copy.
  if (input.sourcePlatform === 'upload') return '';

  const title = typeof input.sourceTitle === 'string' && input.sourceTitle.trim()
    ? input.sourceTitle.trim()
    : typeof input.projectTitle === 'string' && input.projectTitle.trim()
      ? input.projectTitle.trim()
      : '';
  const canonicalTitle = canonicalizeKnownNames(title);
  return [
    canonicalTitle ? `Source title: ${canonicalTitle}` : '',
    typeof input.sourceChannelName === 'string' && input.sourceChannelName.trim()
      ? `Source channel: ${input.sourceChannelName.trim()}`
      : '',
    verifiedSourceSubjectHint(canonicalTitle, input.sourceChannelName),
  ].filter(Boolean).join('\n');
}
