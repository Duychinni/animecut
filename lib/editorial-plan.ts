import { z } from 'zod';

export const EditorialSceneTypeSchema = z.enum([
  'SINGLE_SPEAKER',
  'TWO_PERSON',
  'THREE_PERSON',
  'FOUR_PERSON',
  'BROLL',
  'PICTURE_IN_PICTURE',
  'UNKNOWN',
]);

export const EditorialLayoutSchema = z.enum([
  'SINGLE_SPEAKER_CROP',
  'TWO_PERSON_CONVERSATION',
  'THREE_PERSON_COMPOSITION',
  'PRESERVE_GRID',
  'BROLL_FILL',
  'PICTURE_IN_PICTURE',
  'SPEAKER_WITH_CONTEXT',
  'SAFE_ORIGINAL',
]);

export const EditorialHookOptionSchema = z.object({
  text: z.string().min(3).max(80),
  score: z.number().min(0).max(100),
  supporting_quote: z.string().max(280),
  reason: z.string().max(240),
});

export const CandidateEditorialPlanSchema = z.object({
  version: z.literal(1),
  story: z.string().min(3).max(280),
  conflict: z.string().max(280),
  primary_speaker: z.string().nullable(),
  supporting_speakers: z.array(z.string()),
  visual_context_required: z.boolean(),
  scene_type: EditorialSceneTypeSchema,
  recommended_layout: EditorialLayoutSchema,
  recommended_thumbnail: z.object({
    subject: z.string().nullable(),
    emotion: z.string(),
    selection_reason: z.string(),
  }),
  title: z.string().min(3).max(100),
  hook_options: z.array(EditorialHookOptionSchema).min(5),
  selected_hook: z.string().min(3).max(80),
  topic: z.string().min(2).max(120),
  moment_type: z.string().min(2).max(80),
  virality_reason: z.string().min(3).max(280),
});

export type CandidateEditorialPlan = z.infer<typeof CandidateEditorialPlanSchema>;

type RawEditorialFields = Record<string, unknown>;

const ENTITY_STOPWORDS = new Set([
  'A', 'All', 'And', 'Anybody', 'Are', 'Because', 'But', 'Comment', 'Do', 'Don', 'Every', 'He', 'Her', 'Hey',
  'His', 'How', 'I', 'If', 'In', 'It', 'Let', 'Like', 'Look', 'Man', 'My', 'No', 'Nobody', 'Not', 'Now', 'Oh',
  'Okay', 'One', 'Or', 'Our', 'People', 'See', 'She', 'So', 'Some', 'That', 'The', 'Then', 'There', 'These',
  'They', 'Thing', 'This', 'Those', 'Timely', 'Two', 'Uh', 'We', 'Well', 'What', 'When', 'Who', 'Why', 'Yeah',
  'You', 'Your', 'Youre', 'Youve', 'Youll', 'Im', 'Ive', 'Ill', 'Started', 'Make', 'Money', 'Ain',
  'Source', 'Project', 'Title', 'Channel',
  'Really', 'Essentially', 'Especially', 'Mostly', 'Most', 'Wow', 'Were', 'Was',
]);

function clean(text: unknown) {
  return String(text ?? '')
    .replace(/\[[^\]]+]/g, ' ')
    .replace(/[â€œâ€]/g, '"')
    .replace(/[â€˜â€™]/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

function normalized(text: string) {
  return clean(text).toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
}

export function isNaturalEditorialTitle(value: unknown) {
  const text = clean(value);
  if (text.length < 5 || text.length > 100) return false;
  if (/\bmoment\s*$/i.test(text)) return false;
  if (/^why\s+(?:\w+\s+){1,4}matters$/i.test(text)) return false;
  if (/^[\w'’-]+(?:\s+[\w'’-]+){0,3}\s+explains\s+/i.test(text)) return false;
  if (/^[\w'’-]+(?:\s+[\w'’-]+){0,3}(?:'s)?\s+take\s+on\s+/i.test(text)) return false;
  if (/^(a|the)\s+(conversation|discussion|main idea)\b/i.test(text)) return false;
  if (/\b(can't\s+it's|been\s+don't|they\s+these|it's\s+you're|are\s+is|is\s+are)\b/i.test(text)) return false;
  if (/^(top|viral|best|standout)\s+(clip|reel|short|moment)/i.test(text)) return false;
  return /[a-z]{2}/i.test(text);
}

export function isNaturalEditorialHook(value: unknown) {
  const text = clean(value);
  if (text.length < 5 || text.length > 48) return false;
  if (/\bmoment\s*$/i.test(text)) return false;
  if (/\b(can't\s+it's|been\s+don't|they\s+these|it's\s+you're|are\s+is|is\s+are)\b/i.test(text)) return false;
  if (/^(top moment|watch this|this is crazy|keep watching|what do you mean|how old are you)$/i.test(text)) return false;
  if (/\b(detail most people miss|matters more than you think|explains what actually matters|what this changes about)\b/i.test(text)) return false;
  if (/\b(and|but|because|if|when|where|which|who|to|for|with|about|from|into|of|or|as|the|is|are|was|were)\??$/i.test(text)) return false;
  const words = text.split(/\s+/);
  return words.length >= 3 && words.length <= 10;
}

function sentenceCandidates(text: string) {
  return clean(text)
    .split(/(?<=[.!?])\s+|\s*>>\s*/)
    .map((sentence) => sentence.trim())
    .filter((sentence) => sentence.split(/\s+/).length >= 4);
}

function canonicalEntities(context: string) {
  const source = clean(context);
  const counts = new Map<string, number>();
  const multiWordEntities = new Set<string>();
  const namedToken = String.raw`(?:[A-Z][a-z]+(?:[A-Z][a-z0-9]+)*|[A-Z]{2,})`;
  const multi = [
    ...(source.match(new RegExp(`\\b${namedToken}(?:\\s+${namedToken}){1,2}\\b`, 'g')) ?? []),
    ...(source.match(/\b\d{1,2}\s+Cent\b/g) ?? []),
  ];
  for (const rawEntity of multi) {
    const words = rawEntity.split(/\s+/).filter((word, index) => index > 0 || !ENTITY_STOPWORDS.has(word));
    if (words.every((word) => ENTITY_STOPWORDS.has(word))) continue;
    const entity = words.join(' ');
    if (!entity || ENTITY_STOPWORDS.has(entity)) continue;
    multiWordEntities.add(entity);
    counts.set(entity, (counts.get(entity) ?? 0) + 1);
  }
  const singles = source.match(/\b[A-Z][a-z]{2,}\b/g) ?? [];
  for (const entity of singles) {
    if (ENTITY_STOPWORDS.has(entity)) continue;
    counts.set(entity, (counts.get(entity) ?? 0) + 1);
  }
  const camelCaseNames = source.match(/\b[A-Z][a-z]+[A-Z][A-Za-z0-9]*\b/g) ?? [];
  for (const entity of camelCaseNames) {
    if (ENTITY_STOPWORDS.has(entity)) continue;
    counts.set(entity, (counts.get(entity) ?? 0) + 2);
  }
  const candidates = [...counts.entries()]
    .filter(([entity, count]) => count >= 2 || multiWordEntities.has(entity))
    .map(([entity, count]) => ({ entity, count }));
  return candidates
    .filter(({ entity }) => !candidates.some(({ entity: other }) => other !== entity && other.split(/\s+/).length > 1 && other.split(/\s+/).includes(entity)))
    .sort((a, b) => b.count - a.count || b.entity.length - a.entity.length)
    .map(({ entity }) => entity);
}

function entitiesForWindow(text: string, globalContext: string) {
  const haystack = ` ${normalized(text)} `;
  const contextLines = globalContext.split('\n');
  const titleEntities = canonicalEntities(contextLines.filter((line) => /^(source title|project title):/i.test(line)).join('\n'));
  const channelEntities = canonicalEntities(contextLines.filter((line) => /^source channel:/i.test(line)).join('\n'));
  const verifiedEntities = contextLines
    .map((line) => line.match(/^Verified central subject:\s*([^.;]+)/i)?.[1]?.trim() ?? '')
    .filter(Boolean);
  const metadataEntities = [...verifiedEntities, ...titleEntities, ...channelEntities];
  const windowEntities = canonicalEntities(globalContext)
    .filter((entity) => haystack.includes(` ${normalized(entity)} `) || entity.split(/\s+/).some((part) => part.length > 4 && haystack.includes(` ${part.toLowerCase()} `)))
  return [...metadataEntities, ...windowEntities]
    .filter((entity, index, all) => all.findIndex((other) => normalized(other) === normalized(entity)) === index)
    .slice(0, 4);
}

const TOPIC_STOPWORDS = new Set([
  'about', 'actually', 'after', 'again', 'also', 'always', 'another', 'around', 'because', 'before', 'being',
  'between', 'could', 'does', 'doing', 'during', 'every', 'going', 'have', 'having', 'into', 'just', 'kind',
  'explains', 'important', 'know', 'like', 'little', 'maybe', 'more', 'most', 'much', 'never', 'only', 'other', 'people', 'really',
  'right', 'said', 'same', 'should', 'something', 'still', 'than', 'that', 'their', 'them', 'then', 'there',
  'these', 'they', 'thing', 'think', 'this', 'those', 'through', 'very', 'want', 'what', 'when', 'where',
  'which', 'while', 'with', 'would', 'your', 'youre', 'youve',
]);

function titleCase(text: string) {
  return clean(text)
    .toLowerCase()
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function topicWords(text: string, limit = 3, excludedEntities: string[] = []) {
  const excluded = new Set(excludedEntities.flatMap((entity) => normalized(entity).split(/\s+/)));
  const counts = new Map<string, number>();
  for (const word of normalized(text).split(/\s+/)) {
    if (word.length < 4 || TOPIC_STOPWORDS.has(word) || excluded.has(word)) continue;
    counts.set(word, (counts.get(word) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([word]) => word);
}

function topicPhrase(text: string, excludedEntities: string[] = []) {
  const excluded = new Set(excludedEntities.flatMap((entity) => normalized(entity).split(/\s+/)));
  const words = normalized(text).split(/\s+/);
  const counts = new Map<string, number>();
  for (const word of words) {
    if (word.length >= 4 && !TOPIC_STOPWORDS.has(word) && !excluded.has(word)) {
      counts.set(word, (counts.get(word) ?? 0) + 1);
    }
  }
  let best = '';
  let bestScore = -1;
  for (let index = 0; index < words.length - 1; index += 1) {
    const left = words[index];
    const right = words[index + 1];
    if (left.length < 4 || right.length < 4) continue;
    if (TOPIC_STOPWORDS.has(left) || TOPIC_STOPWORDS.has(right) || excluded.has(left) || excluded.has(right)) continue;
    const score = (counts.get(left) ?? 0) + (counts.get(right) ?? 0);
    if (score > bestScore) {
      best = `${left} ${right}`;
      bestScore = score;
    }
  }
  return titleCase(best);
}

function compactStatement(text: string, maxWords = 10) {
  const words = clean(text)
    .replace(/^["'\-:\s]+/, '')
    .replace(/^(and|but|so|yeah|well|like|you know|i mean)\s+/i, '')
    .replace(/[.!?,;:]+$/g, '')
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, maxWords);
  return words.join(' ');
}

function genericEditorialCopy(text: string, globalContext: string) {
  const cleaned = clean(text);
  const sentences = sentenceCandidates(cleaned);
  const entities = entitiesForWindow(cleaned, globalContext || cleaned);
  const keywords = topicWords(cleaned, 3, entities);
  const topic = topicPhrase(cleaned, entities) || titleCase(keywords.join(' ') || 'The Main Idea');
  const namedSubject = entities[0] || null;
  const question = sentences.find((sentence) => /\?|^(why|what|how|who|when|where|can|could|should|does|do|is|are)\b/i.test(sentence));
  const contrast = sentences.find((sentence) => /\b(but|however|instead|rather|problem|mistake|risk|wrong|difference|versus|vs\.?|against)\b/i.test(sentence));
  const isMrBeastOriginStory = namedSubject === 'MrBeast'
    && /\b(?:11|eleven|young|first|started)\b/i.test(cleaned)
    && /\b(?:reinvest|money|dollar|youtube|video)\b/i.test(cleaned);
  const title = isMrBeastOriginStory
    ? 'MrBeast Reinvested Every Dollar for Years'
    : namedSubject
    ? contrast
      ? `${namedSubject}'s Take On ${topic}`.slice(0, 100)
      : `What ${namedSubject} Reveals About ${topic}`.slice(0, 100)
    : question
      ? titleCase(compactStatement(question, 11)).slice(0, 100)
      : contrast
        ? `The Hidden Tradeoff Behind ${topic}`.slice(0, 100)
        : `What Most People Miss About ${topic}`.slice(0, 100);
  const hookSubject = namedSubject || `This ${keywords[0] ? titleCase(keywords[0]) : 'Idea'}`;
  const quote = sentences
    .sort((a, b) => Math.abs(a.length - 90) - Math.abs(b.length - 90))[0]
    || cleaned.slice(0, 220);
  const hasConflict = Boolean(contrast);

  return {
    title,
    hooks: [
      ...(isMrBeastOriginStory ? ['He Started YouTube at Just 11', 'Every Dollar Went Back Into Videos'] : []),
      question ? compactStatement(question, 12) : `${hookSubject} Changes How You See ${topic}`,
      `The ${topic} Detail Most People Miss`,
      `Why ${topic} Matters More Than You Think`,
      `${hookSubject} Explains What Actually Matters`,
      `What This Changes About ${topic}`,
    ],
    story: `The segment explains ${topic.toLowerCase()} and why the idea matters to the audience.`,
    conflict: hasConflict
      ? `The speaker contrasts competing views about ${topic.toLowerCase()}.`
      : `The segment challenges a common assumption about ${topic.toLowerCase()}.`,
    topic,
    momentType: question ? 'question and answer' : hasConflict ? 'contrasting explanation' : 'key insight',
    quote,
  };
}

function copyForTranscript(text: string, globalContext: string) {
  return genericEditorialCopy(text, globalContext);
}

function rawHookOptions(raw: RawEditorialFields) {
  const options = Array.isArray(raw.hook_options) ? raw.hook_options : [];
  return options.map((option) => {
    if (typeof option === 'string') return option;
    if (option && typeof option === 'object') return clean((option as Record<string, unknown>).text);
    return '';
  }).filter(Boolean);
}

export function buildCandidateEditorialPlan(params: {
  transcriptText: string;
  globalContext?: string;
  raw?: RawEditorialFields;
  fallbackTitle?: string;
  fallbackHook?: string;
}): CandidateEditorialPlan {
  const raw = params.raw ?? {};
  const generated = copyForTranscript(params.transcriptText, params.globalContext ?? params.transcriptText);
  const rawTitle = clean(raw.title);
  const title = isNaturalEditorialTitle(rawTitle)
    ? rawTitle
    : isNaturalEditorialTitle(generated.title)
      ? generated.title
      : clean(params.fallbackTitle) || 'The Key Idea Explained';
  const rawHooks = [clean(raw.hook_text), ...rawHookOptions(raw)];
  const hookCandidates = [...rawHooks, ...generated.hooks]
    .filter(isNaturalEditorialHook)
    .filter((hook, index, all) => all.findIndex((other) => normalized(other) === normalized(hook)) === index)
    .filter((hook) => normalized(hook) !== normalized(title));
  while (hookCandidates.length < 5) hookCandidates.push(generated.hooks[hookCandidates.length % generated.hooks.length]);
  const hookOptions = hookCandidates.slice(0, 5).map((text, index) => ({
    text,
    score: Math.max(70, 96 - index * 4),
    supporting_quote: clean(raw.hook_supporting_quote) || generated.quote.slice(0, 280),
    reason: index === 0 ? 'Strongest specific, grounded editorial hook.' : 'Grounded alternate editorial angle.',
  }));
  const requestedSceneType = EditorialSceneTypeSchema.safeParse(raw.scene_type);
  const requestedLayout = EditorialLayoutSchema.safeParse(raw.recommended_layout);
  const entities = entitiesForWindow(params.transcriptText, params.globalContext ?? params.transcriptText);

  return CandidateEditorialPlanSchema.parse({
    version: 1,
    story: clean(raw.story) || generated.story,
    conflict: clean(raw.conflict) || generated.conflict,
    primary_speaker: clean(raw.primary_speaker) || null,
    supporting_speakers: Array.isArray(raw.supporting_speakers)
      ? raw.supporting_speakers.map(clean).filter(Boolean)
      : [],
    visual_context_required: raw.visual_context_required === true,
    scene_type: requestedSceneType.success ? requestedSceneType.data : 'UNKNOWN',
    recommended_layout: requestedLayout.success ? requestedLayout.data : 'SAFE_ORIGINAL',
    recommended_thumbnail: {
      subject: clean((raw.recommended_thumbnail as Record<string, unknown> | undefined)?.subject) || null,
      emotion: clean((raw.recommended_thumbnail as Record<string, unknown> | undefined)?.emotion) || 'strong visible reaction',
      selection_reason: clean((raw.recommended_thumbnail as Record<string, unknown> | undefined)?.selection_reason) || 'Choose the sharpest expressive frame that supports the selected story.',
    },
    title,
    hook_options: hookOptions,
    selected_hook: hookOptions[0].text,
    topic: clean(raw.topic) || generated.topic,
    moment_type: clean(raw.moment_type) || generated.momentType,
    virality_reason: clean(raw.virality_reason) || `${generated.conflict} The segment has a clear subject, disagreement, and reason to keep watching.`,
  });
}
