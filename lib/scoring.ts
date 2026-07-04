export function overallScore(input: {
  hook_strength: number;
  emotional_intensity: number;
  clarity_without_context: number;
  rewatch_potential: number;
}) {
  const weighted =
    input.hook_strength * 0.35 +
    input.emotional_intensity * 0.2 +
    input.clarity_without_context * 0.3 +
    input.rewatch_potential * 0.15;
  return Number(weighted.toFixed(2));
}
