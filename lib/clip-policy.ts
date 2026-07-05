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
    return { targetMin: 5, targetMax: 5, candidateCount: 20, expectedMinSec: 20, expectedMaxSec: 35, minSec: 15, maxSec: 45 };
  }
  if (minutes <= 5) {
    return { targetMin: 5, targetMax: 6, candidateCount: 25, expectedMinSec: 20, expectedMaxSec: 40, minSec: 20, maxSec: 60 };
  }
  if (minutes <= 10) {
    return { targetMin: 6, targetMax: 8, candidateCount: 35, expectedMinSec: 25, expectedMaxSec: 45, minSec: 20, maxSec: 75 };
  }
  if (minutes <= 20) {
    return { targetMin: 8, targetMax: 10, candidateCount: 50, expectedMinSec: 30, expectedMaxSec: 60, minSec: 25, maxSec: 90 };
  }
  if (minutes <= 30) {
    return { targetMin: 10, targetMax: 12, candidateCount: 70, expectedMinSec: 30, expectedMaxSec: 60, minSec: 30, maxSec: 90 };
  }
  if (minutes <= 60) {
    return { targetMin: 15, targetMax: 18, candidateCount: 100, expectedMinSec: 30, expectedMaxSec: 75, minSec: 30, maxSec: 90 };
  }
  if (minutes <= 90) {
    return { targetMin: 18, targetMax: 20, candidateCount: 140, expectedMinSec: 30, expectedMaxSec: 75, minSec: 30, maxSec: 90 };
  }
  if (minutes <= 120) {
    return { targetMin: 20, targetMax: 20, candidateCount: 180, expectedMinSec: 30, expectedMaxSec: 90, minSec: 30, maxSec: 90 };
  }

  return { targetMin: 20, targetMax: 20, candidateCount: 250, expectedMinSec: 30, expectedMaxSec: 90, minSec: 30, maxSec: 90 };
}

export function getTargetClipCount(totalSeconds: number) {
  const policy = getClipPolicy(totalSeconds);
  return Math.min(20, policy.targetMax);
}
