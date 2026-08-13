const VAGUE_OPENING = /^(?:i mean|you know|the thing is|the thing about it is|what i will say is|here'?s the thing|let me tell you|to be honest|honestly|basically|actually|anyway|we were talking about|going back to|as i was saying)\b/i;
const DANGLING_REFERENCE = /^(?:he|she|they|it|that|this|those|these)\b/i;
const HOOK_SIGNAL = /[?!]|\b(?:why|how|what|who|when|where|never|always|first|last|only|best|worst|biggest|hardest|craziest|secret|truth|mistake|problem|wrong|fight|ufc|mma|knockout|challenge|called? out|trash talk|scared|risk|almost|nearly|could have|changed|realized|found out|lost|won|killed|died|love|hate|respect|grateful|sorry|funny|laughed)\b/i;

export function hasClearFirstFiveSecondHook(text: string) {
  const cleaned = String(text ?? '')
    .replace(/^['"“”‘’\-–—\s]+/, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!cleaned || VAGUE_OPENING.test(cleaned)) return false;

  const words = cleaned.split(/\s+/).filter(Boolean);
  if (words.length < 4) return false;

  // A dangling pronoun is acceptable only when the same opening immediately
  // supplies a concrete hook signal; otherwise a new viewer has no subject.
  if (DANGLING_REFERENCE.test(cleaned) && !HOOK_SIGNAL.test(cleaned)) return false;

  const meaningful = words.filter((word) => !/^(?:i|a|an|the|and|but|so|like|just|really|very|was|were|is|are|to|of|in|on|at|for)$/i.test(word));
  return meaningful.length >= 3 && (HOOK_SIGNAL.test(cleaned) || meaningful.length >= 7);
}
