export type ClipCandidate = {
  id?: string;
  start_sec: number;
  end_sec: number;
  title: string;
  reason: string;
  hook_strength: number;
  emotional_intensity: number;
  clarity_without_context: number;
  rewatch_potential: number;
  overall_score: number;
  rank?: number;
};
