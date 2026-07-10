export type ClipPolicy = {
  targetMin: number;
  targetMax: number;
  candidateCount: number;
  expectedMinSec: number;
  expectedMaxSec: number;
  minSec: number;
  maxSec: number;
};

export function getClipPolicy(totalSeconds: number): ClipPolicy {
  const minutes = totalSeconds / 60;

  if (minutes <= 2) {
    return { targetMin: 1, targetMax: 4, candidateCount: 10, expectedMinSec: 18, expectedMaxSec: 35, minSec: 15, maxSec: 45 };
  }
  if (minutes <= 5) {
    return { targetMin: 2, targetMax: 5, candidateCount: 14, expectedMinSec: 20, expectedMaxSec: 40, minSec: 18, maxSec: 60 };
  }
  if (minutes <= 10) {
    return { targetMin: 4, targetMax: 8, candidateCount: 30, expectedMinSec: 22, expectedMaxSec: 45, minSec: 20, maxSec: 75 };
  }
  if (minutes <= 20) {
    return { targetMin: 6, targetMax: 10, candidateCount: 40, expectedMinSec: 25, expectedMaxSec: 55, minSec: 22, maxSec: 90 };
  }
  if (minutes <= 30) {
    return { targetMin: 8, targetMax: 12, candidateCount: 55, expectedMinSec: 30, expectedMaxSec: 60, minSec: 25, maxSec: 90 };
  }
  if (minutes <= 45) {
    return { targetMin: 8, targetMax: 14, candidateCount: 55, expectedMinSec: 30, expectedMaxSec: 65, minSec: 28, maxSec: 90 };
  }
  if (minutes <= 60) {
    return { targetMin: 10, targetMax: 14, candidateCount: 70, expectedMinSec: 30, expectedMaxSec: 75, minSec: 30, maxSec: 90 };
  }
  if (minutes <= 90) {
    return { targetMin: 12, targetMax: 15, candidateCount: 90, expectedMinSec: 30, expectedMaxSec: 75, minSec: 30, maxSec: 90 };
  }
  if (minutes <= 120) {
    return { targetMin: 15, targetMax: 18, candidateCount: 120, expectedMinSec: 30, expectedMaxSec: 90, minSec: 30, maxSec: 100 };
  }

  return { targetMin: 18, targetMax: 20, candidateCount: 150, expectedMinSec: 30, expectedMaxSec: 90, minSec: 30, maxSec: 120 };
}

export function getTargetClipCount(totalSeconds: number) {
  const policy = getClipPolicy(totalSeconds);
  return Math.min(20, policy.targetMax);
}
