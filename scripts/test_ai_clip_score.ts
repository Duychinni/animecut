import assert from 'node:assert/strict';
import { calculateAiClipScore, clipScoreLabel, transcriptTechnicalMetrics } from '../lib/clip-score';

const strongSemantic = {
  hook_strength: 92,
  payoff_value: 90,
  standalone_clarity: 88,
  emotion_novelty: 86,
  shareability: 84,
  semantic_pacing: 90,
  explanations: {
    hook_strength: 'Immediate curiosity-driven opening',
    payoff_value: 'Clear standalone payoff',
    standalone_clarity: 'Makes sense without prior context',
  },
};

const cleanMetrics = transcriptTechnicalMetrics(
  [{ start: 0.2, end: 8, text: 'Here is the setup.' }, { start: 8.2, end: 24, text: 'Here is the complete payoff.' }],
  0,
  24.5,
);
const strong = calculateAiClipScore({ semantic: strongSemantic, technicalMetrics: cleanMetrics, technicalQuality: 92 });
assert.ok(strong.final_score >= 80 && strong.final_score <= 100);
assert.equal(strong.label, clipScoreLabel(strong.final_score));

const silent = calculateAiClipScore({
  semantic: strongSemantic,
  technicalMetrics: { ...cleanMetrics, speech_onset_seconds: 2.2, silence_ratio: 0.30 },
  technicalQuality: 90,
});
assert.ok(silent.penalties.some((penalty) => penalty.reason === 'non_meaningful_opening_silence'));
assert.ok(silent.penalties.some((penalty) => penalty.reason === 'excessive_dead_air'));
assert.ok(silent.final_score < strong.final_score);

const broken = calculateAiClipScore({
  semantic: strongSemantic,
  technicalMetrics: cleanMetrics,
  startsMidSentence: true,
  endsBeforePayoff: true,
});
assert.equal(broken.penalties.reduce((sum, penalty) => sum + penalty.points, 0), 18);

const frozen = calculateAiClipScore({
  semantic: strongSemantic,
  technicalMetrics: { ...cleanMetrics, black_frame_ratio: 0.2, frozen_frame_ratio: 0.15 },
});
assert.ok(frozen.penalties.some((penalty) => penalty.reason === 'major_black_or_frozen_section'));

const staticPodcast = calculateAiClipScore({
  semantic: strongSemantic,
  technicalMetrics: { ...cleanMetrics, scene_boundary_count: 0 },
  technicalQuality: 90,
});
assert.equal(staticPodcast.final_score, strong.final_score);

const weak = calculateAiClipScore({
  semantic: {
    hook_strength: 40,
    payoff_value: 45,
    standalone_clarity: 55,
    emotion_novelty: 35,
    shareability: 30,
    semantic_pacing: 50,
    explanations: {},
  },
  technicalMetrics: cleanMetrics,
});
assert.ok(weak.final_score < 70);
assert.equal(weak.label, 'Weak');

const almostPerfectButUncertain = calculateAiClipScore({
  semantic: {
    hook_strength: 100,
    payoff_value: 100,
    standalone_clarity: 100,
    emotion_novelty: 100,
    shareability: 100,
    semantic_pacing: 100,
    explanations: {},
  },
  technicalMetrics: cleanMetrics,
  technicalQuality: 100,
  scoreConfidence: 0.8,
});
assert.equal(almostPerfectButUncertain.final_score, 99, '100 requires high-confidence near-perfect evidence');

const perfect = calculateAiClipScore({
  semantic: {
    hook_strength: 100,
    payoff_value: 100,
    standalone_clarity: 100,
    emotion_novelty: 100,
    shareability: 100,
    semantic_pacing: 100,
    explanations: {},
  },
  technicalMetrics: cleanMetrics,
  technicalQuality: 100,
  scoreConfidence: 0.95,
});
assert.equal(perfect.final_score, 100);

console.log('AI Clip Score regression tests passed.');
