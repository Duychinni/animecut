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
    return { targetMin: 1, targetMax: 4, candidateCount: 10, expectedMinSec: 18, expectedMaxSec: 35, minSec: 15, maxSec: 90 };
  }
  if (minutes <= 5) {
    return { targetMin: 3, targetMax: 8, candidateCount: 30, expectedMinSec: 18, expectedMaxSec: 40, minSec: 15, maxSec: 90 };
  }
  if (minutes <= 10) {
    return { targetMin: 6, targetMax: 12, candidateCount: 60, expectedMinSec: 20, expectedMaxSec: 48, minSec: 18, maxSec: 90 };
  }
  if (minutes <= 20) {
    return { targetMin: 10, targetMax: 16, candidateCount: 80, expectedMinSec: 22, expectedMaxSec: 55, minSec: 20, maxSec: 90 };
  }
  if (minutes <= 30) {
    return { targetMin: 12, targetMax: 18, candidateCount: 90, expectedMinSec: 25, expectedMaxSec: 60, minSec: 22, maxSec: 90 };
  }
  if (minutes <= 60) {
    return { targetMin: 15, targetMax: 20, candidateCount: 100, expectedMinSec: 28, expectedMaxSec: 70, minSec: 25, maxSec: 90 };
  }
  if (minutes <= 90) {
    return { targetMin: 17, targetMax: 22, candidateCount: 110, expectedMinSec: 30, expectedMaxSec: 75, minSec: 28, maxSec: 90 };
  }
  if (minutes <= 120) {
    return { targetMin: 19, targetMax: 25, candidateCount: 125, expectedMinSec: 30, expectedMaxSec: 90, minSec: 30, maxSec: 100 };
  }
  if (minutes <= 180) {
    return { targetMin: 21, targetMax: 27, candidateCount: 145, expectedMinSec: 30, expectedMaxSec: 90, minSec: 30, maxSec: 110 };
  }

  return { targetMin: 24, targetMax: 30, candidateCount: 180, expectedMinSec: 30, expectedMaxSec: 90, minSec: 30, maxSec: 120 };
}

export function getTargetClipCount(totalSeconds: number) {
  return getClipPolicy(totalSeconds).targetMax;
}

export function getRequiredClipCount(totalSeconds: number) {
  const policy = getClipPolicy(totalSeconds);
  return Math.min(policy.targetMin, getTargetClipCount(totalSeconds));
}
