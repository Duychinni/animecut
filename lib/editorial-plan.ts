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
  if (/\b(can't\s+it's|been\s+don't|they\s+these|it's\s+you're|are\s+is|is\s+are)\b/i.test(text)) return false;
  if (/^(top|viral|best|standout)\s+(clip|reel|short|moment)/i.test(text)) return false;
  return /[a-z]{2}/i.test(text);
}

export function isNaturalEditorialHook(value: unknown) {
  const text = clean(value);
  if (text.length < 5 || text.length > 80) return false;
  if (/\bmoment\s*$/i.test(text)) return false;
  if (/\b(can't\s+it's|been\s+don't|they\s+these|it's\s+you're|are\s+is|is\s+are)\b/i.test(text)) return false;
  if (/^(top moment|watch this|this is crazy|keep watching|what do you mean|how old are you)$/i.test(text)) return false;
  if (/\b(and|but|because|if|when|where|which|who|to|for|with|about|from|into|of|or|as|the|is|are|was|were)\??$/i.test(text)) return false;
  return text.split(/\s+/).length >= 3;
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
  const multi = source.match(/\b(?:[A-Z][a-z]+|[A-Z]{2,}|\d{2,})(?:\s+(?:[A-Z][a-z]+|[A-Z]{2,}|Cent)){1,2}\b/g) ?? [];
  for (const rawEntity of multi) {
    const words = rawEntity.split(/\s+/).filter((word, index) => index > 0 || !ENTITY_STOPWORDS.has(word));
    if (words.every((word) => ENTITY_STOPWORDS.has(word))) continue;
    const entity = words.join(' ');
    if (!entity || ENTITY_STOPWORDS.has(entity)) continue;
    counts.set(entity, (counts.get(entity) ?? 0) + 1);
  }
  const singles = source.match(/\b[A-Z][a-z]{2,}\b/g) ?? [];
  for (const entity of singles) {
    if (ENTITY_STOPWORDS.has(entity)) continue;
    counts.set(entity, (counts.get(entity) ?? 0) + 1);
  }
  const candidates = [...counts.entries()]
    .filter(([, count]) => count >= 2)
    .map(([entity, count]) => ({ entity, count }));
  return candidates
    .filter(({ entity }) => !candidates.some(({ entity: other }) => other !== entity && other.split(/\s+/).length > 1 && other.split(/\s+/).includes(entity)))
    .sort((a, b) => b.count - a.count || b.entity.length - a.entity.length)
    .map(({ entity }) => entity);
}

function entitiesForWindow(text: string, globalContext: string) {
  const haystack = ` ${normalized(text)} `;
  return canonicalEntities(globalContext)
    .filter((entity) => haystack.includes(` ${normalized(entity)} `) || entity.split(/\s+/).some((part) => part.length > 4 && haystack.includes(` ${part.toLowerCase()} `)))
    .slice(0, 4);
}

function matchup(text: string, entities: string[]) {
  const explicit = clean(text).match(/\b([A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)\s+(?:versus|vs\.?|against)\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)/i);
  if (explicit) return `${explicit[1]} vs. ${explicit[2]}`;
  return entities.length >= 2 ? `${entities[0]} vs. ${entities[1]}` : null;
}

function subject(entities: string[], fallback = 'The Fighters') {
  return entities[0] || fallback;
}

function copyForTranscript(text: string, globalContext: string) {
  const cleaned = clean(text);
  const lower = cleaned.toLowerCase();
  const entities = entitiesForWindow(cleaned, globalContext || cleaned);
  const quote = sentenceCandidates(cleaned)
    .sort((a, b) => {
      const signal = (value: string) => (/\b(bet|money|fight|knock|soft|boring|prove|credit|believe|wrong|best|scared|refuse|defense)\b/i.test(value) ? 1 : 0);
      return signal(b) - signal(a) || Math.abs(a.length - 72) - Math.abs(b.length - 72);
    })[0] || cleaned.slice(0, 220);

  if (/\b(street fight|street fighting)\b/.test(lower) && /\bboxing\b/.test(lower)) {
    return {
      title: 'Boxing vs. Street Fighting: The Heated Debate',
      hooks: ['Boxing Is Nothing Like a Street Fight', 'Who Actually Wins Outside the Ring?', 'Why Neither Side Would Back Down', 'The Argument That Turned Personal', 'Boxing Rules Change Everything'],
      story: 'The speakers clash over the difference between boxing and a real street fight.',
      conflict: 'Professional boxing skill is compared with an uncontrolled street fight.', topic: 'Boxing vs. street fighting', momentType: 'debate', quote,
    };
  }
  const recordMatch = lower.match(/\b(\d{1,3})\s+(?:fights?|bouts?).{0,24}?(\d{1,3})\s+(?:knockouts?|kos?)\b/)
    ?? lower.match(/\b(\d{1,3})\s+(?:knockouts?|kos?).{0,24}?(\d{1,3})\s+(?:fights?|bouts?)\b/);
  if (recordMatch) {
    const fightsFirst = /fights?|bouts?/.test(recordMatch[0].slice(0, recordMatch[0].indexOf(recordMatch[1]) + recordMatch[1].length + 8));
    const fights = fightsFirst ? recordMatch[1] : recordMatch[2];
    const knockouts = fightsFirst ? recordMatch[2] : recordMatch[1];
    return {
      title: `${knockouts} Knockouts in ${fights} Fights`,
      hooks: [`Can Anyone Survive This Knockout Power?`, `${knockouts} Knockouts in Just ${fights} Fights`, 'The Record Behind the Fight Prediction', 'One Stat Changed the Entire Debate', 'Why Knockout Power Changes Everything'],
      story: 'A knockout record becomes the strongest evidence in the fight prediction.',
      conflict: `Elite defense is weighed against a ${knockouts}-knockout power record.`, topic: 'Knockout record', momentType: 'stat-driven debate', quote,
    };
  }
  if (/\bhow old are you\b/.test(lower) && /\b(weight|weight class|age)\b/.test(lower)) {
    return {
      title: 'The Age and Weight Challenge That Escalated the Debate',
      hooks: ['He Turned the Debate Into a Personal Challenge', 'Why Did Age and Weight Enter the Argument?', 'The Question That Made the Debate Personal', 'This Was No Longer Just Fight Talk', 'The Challenge Nobody Expected'],
      story: 'A sports disagreement escalates into a personal challenge about age, size, and credibility.',
      conflict: 'A technical debate becomes a direct personal confrontation.', topic: 'Age and weight challenge', momentType: 'personal escalation', quote,
    };
  }
  if (/\b(real money|bet|betting|wager)\b/.test(lower)) {
    return {
      title: 'The Real-Money Bet Behind the Fight Debate',
      hooks: ['The Bet That Could Settle the Debate', 'How Much Would You Risk on This Fight?', 'A Prediction Is Easy Until Money Is Involved', 'This Fight Debate Just Got Expensive', 'Someone Finally Asked for Real Money'],
      story: 'A fight prediction turns into a challenge to put real money behind the claim.',
      conflict: 'A verbal prediction becomes a direct financial challenge.', topic: 'A real-money fight bet', momentType: 'challenge', quote,
    };
  }
  if (/\b(best basketball player|best without showing|had to show|prove|greatness)\b/.test(lower)) {
    return {
      title: 'The Sports Analogy Behind the Greatness Debate',
      hooks: ['Can You Be Great Without Proving It?', 'Calling Yourself the Best Is Not Enough', 'The Sports Comparison Changed the Debate', 'Would You Believe Greatness Without Proof?', 'Even the Best Still Have to Show It'],
      story: 'A sports analogy challenges whether someone can claim greatness before proving it publicly.',
      conflict: 'Self-belief is challenged by the demand for visible proof.', topic: 'Proving boxing greatness', momentType: 'sports analogy', quote,
    };
  }
  if (/\b(soft|ducking|not ducking|smoke)\b/.test(lower)) {
    return {
      title: 'The Fight-Ducking Accusation Behind the Debate',
      hooks: ['He Says He Is Not Ducking Anyone', 'The Accusation That Changed the Debate', 'He Finally Answers His Critics', 'Why This Fight Still Has Not Happened', 'The Fight Claim He Could Not Ignore'],
      story: 'A fighter answers accusations about avoiding the matchup and questions the opposition.',
      conflict: 'One side claims the major fight is being avoided.', topic: 'Fight avoidance accusations', momentType: 'rebuttal', quote,
    };
  }
  if (/\b(boring|defensive|defense|hitting and not getting hit|solve that puzzle)\b/.test(lower)) {
    return {
      title: 'Why Defensive Boxing Divides Fight Fans',
      hooks: ['Why Fans Call This Style Boring', 'Can Anyone Solve This Defense?', 'Winning Is Not Enough for the Fans', 'The Style Debate Dividing Boxing Fans', 'Defense Wins Fights but Loses Viewers'],
      story: 'Defensive skill is weighed against the action and knockouts fight fans expect.',
      conflict: 'Winning safely conflicts with the demand for action and knockouts.', topic: 'Defensive boxing style', momentType: 'style debate', quote,
    };
  }
  if (/\b(prove|show you|credit you deserve|best fighter|best basketball)\b/.test(lower)) {
    return {
      title: 'Why Greatness Still Has to Be Proven',
      hooks: ['Calling Yourself the Best Is Not Enough', 'You Cannot Claim Greatness Without Proof', 'He Says the Proof Is Already There', 'Why Greatness Has to Be Shown', 'The Comparison That Changed the Argument'],
      story: 'The speakers argue over whether elite status has already been demonstrated or still needs proof.',
      conflict: 'Reputation is challenged by the demand for visible proof.', topic: 'Proving greatness', momentType: 'argument', quote,
    };
  }
  if (/\b(knockout|knock out|ko\b)\b/.test(lower)) {
    return {
      title: 'The Knockout Claim That Started the Argument',
      hooks: ['Can He Actually Get the Knockout?', 'The Knockout Threat Nobody Believed', 'This Fight Prediction Got Personal', 'One Claim Started the Entire Argument', 'Why Neither Side Backed Down'],
      story: 'The speakers argue over whether the predicted knockout can actually happen.',
      conflict: 'One side doubts the fighter has enough power to finish the matchup.', topic: 'Knockout power', momentType: 'heated debate', quote,
    };
  }

  const fallbackTitle = 'The Disagreement Behind the Fight Prediction';
  return {
    title: fallbackTitle,
    hooks: ['Neither Side Would Back Down', 'Why They Disagree on the Fight', 'The Prediction That Started the Argument', 'The Claim That Changed the Debate', 'Why This Argument Got Personal'],
    story: 'The speakers explain their disagreement and defend opposing fight predictions.',
    conflict: 'The speakers disagree about the outcome and the evidence behind it.', topic: 'Fight prediction', momentType: 'debate', quote,
  };
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
      : clean(params.fallbackTitle) || 'The Debate Behind the Prediction';
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
