export type EditorialExclusionReason =
  | 'intro_or_cold_open'
  | 'outro_or_end_card'
  | 'sponsor_or_promotional_break'
  | 'recap_or_transition_break';

const INTRO_SIGNALS = [
  /\b(welcome (?:back )?to|you(?:'re| are) (?:watching|listening to))\b/i,
  /\b(today(?:'s| on the) (?:episode|show|podcast)|on this episode)\b/i,
  /\b(my guest (?:today|is)|please welcome|joining (?:me|us) today)\b/i,
  /\b(this is (?:the )?[\w' -]+ (?:show|podcast)|brought to you by)\b/i,
  /\b(intro music|theme music|opening credits)\b/i,
];

const OUTRO_SIGNALS = [
  /\b(thanks? for (?:watching|listening|tuning in|joining (?:me|us)))\b/i,
  /\b(see you (?:next time|in the next|on the next)|until next time)\b/i,
  /\b(don't forget to|make sure (?:you )?to) (?:like|subscribe|follow|share)\b/i,
  /\b(like and subscribe|subscribe to (?:the|my|our) (?:channel|podcast))\b/i,
  /\b(link (?:is )?in the description|check out (?:the|our|my) (?:website|links?))\b/i,
  /\b(outro music|end credits|closing credits)\b/i,
];

const SPONSOR_SIGNALS = [
  /\b(this (?:episode|video|show) is (?:brought to you|sponsored) by|thanks to .{0,40} for sponsoring)\b/i,
  /\b(a (?:quick )?word from (?:our|the) sponsor|today(?:'s)? sponsor is|our sponsor today)\b/i,
  /\b(use (?:the )?(?:code|promo code)|use my code|coupon code|discount code)\b/i,
  /\b(save \d{1,2}%|get \d{1,2}% off|free trial|special offer)\b.{0,80}\b(link|description|checkout|sign up)\b/i,
  /\b(visit|go to|head to)\s+(?:www\.|https?:\/\/|[\w-]+\.(?:com|co|io|ai))\b/i,
];

const BREAK_SIGNALS = [
  /\b(we(?:'ll| will) be right back|after (?:this|the) break|before (?:we|you) go to break)\b/i,
  /\b(let(?:'s| us) take a (?:quick |short )?break|time for a (?:quick |short )?break)\b/i,
  /\b(coming up after the break|stay tuned|previously on|last time on)\b/i,
  /\b(quick recap|to recap|here(?:'s| is) what you missed)\b/i,
  /\b(intermission|commercial break|ad break|music break)\b/i,
];

function signalCount(text: string, signals: RegExp[]) {
  return signals.reduce((count, signal) => count + (signal.test(text) ? 1 : 0), 0);
}

/**
 * Reject packaging around the editorial content, while preserving genuine cold
 * opens and closing payoffs. Position alone is never enough: a transcript must
 * also contain recognizable show-intro or sign-off language.
 */
export function editorialExclusionReason(params: {
  text: string;
  startSec: number;
  endSec: number;
  totalSeconds: number;
}): EditorialExclusionReason | null {
  const text = String(params.text ?? '').replace(/\s+/g, ' ').trim();
  if (!text) return null;

  const total = Math.max(1, Number(params.totalSeconds) || 1);
  const start = Math.max(0, Number(params.startSec) || 0);
  const end = Math.max(start, Number(params.endSec) || start);
  const introZone = start <= Math.min(120, Math.max(35, total * 0.08));
  const outroZone = end >= total - Math.min(150, Math.max(45, total * 0.1));
  const introSignals = signalCount(text, INTRO_SIGNALS);
  const outroSignals = signalCount(text, OUTRO_SIGNALS);
  const sponsorSignals = signalCount(text, SPONSOR_SIGNALS);
  const breakSignals = signalCount(text, BREAK_SIGNALS);

  // Sponsor reads and structural breaks can occur anywhere in a source. Never
  // turn them into reels, even when a model gives the window a high score.
  if (sponsorSignals > 0) return 'sponsor_or_promotional_break';
  if (breakSignals > 0) return 'recap_or_transition_break';
  if (introZone && introSignals > 0) return 'intro_or_cold_open';
  if (outroZone && outroSignals > 0) return 'outro_or_end_card';
  return null;
}
