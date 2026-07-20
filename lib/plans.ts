export type BillingInterval = 'monthly' | 'yearly';
export type PlanId = 'free' | 'starter' | 'creator' | 'pro' | 'business';
export type SelfServePlanId = Exclude<PlanId, 'free' | 'business'>;

export const FREE_TRIAL_UPLOADS = 1;
export const FREE_TRIAL_MAX_UPLOAD_MINUTES = 20;
export const EXTRA_USAGE_PRICE_PER_MINUTE = 0.1;

export type PlanConfig = {
  id: SelfServePlanId;
  name: string;
  subtitle: string;
  monthlyPrice: string;
  originalMonthlyPrice?: string;
  discountLabel?: string;
  yearlyPrice?: string;
  yearlyBadge?: string;
  highlighted?: boolean;
  processingMinutes: number;
  maxUploadLengthMinutes: number;
  maxGeneratedClips: number;
  featureLabels?: string[];
  cta: string;
  secondaryCta?: string;
};

export const PLAN_CONFIG: PlanConfig[] = [
  {
    id: 'starter',
    name: 'Starter',
    subtitle: 'For occasional creators getting started',
    monthlyPrice: '$9.99',
    processingMinutes: 300,
    maxUploadLengthMinutes: 60,
    maxGeneratedClips: 12,
    featureLabels: ['1080p exports', 'Dynamic captions', 'Speaker-aware reframing', 'No watermark'],
    cta: 'Start with Starter',
    secondaryCta: 'Up to 5 hours of source video each month',
  },
  {
    id: 'creator',
    name: 'Creator',
    subtitle: 'For consistent weekly short-form content',
    monthlyPrice: '$19.99',
    originalMonthlyPrice: '$29.99',
    discountLabel: '33% off',
    highlighted: true,
    processingMinutes: 800,
    maxUploadLengthMinutes: 120,
    maxGeneratedClips: 20,
    featureLabels: ['Everything in Starter', 'Advanced AI clip scoring', 'Caption presets', 'Faster processing queue'],
    cta: 'Choose Creator',
    secondaryCta: 'Best value for active creators',
  },
  {
    id: 'pro',
    name: 'Pro',
    subtitle: 'For professionals and high-volume workflows',
    monthlyPrice: '$39.99',
    processingMinutes: 1500,
    maxUploadLengthMinutes: 180,
    maxGeneratedClips: 30,
    featureLabels: ['Everything in Creator', 'Priority processing', 'Highest monthly allowance', 'Priority support'],
    cta: 'Choose Pro',
    secondaryCta: 'Built for daily publishing and client work',
  },
];

export const PLAN_LOOKUP = Object.fromEntries(PLAN_CONFIG.map((plan) => [plan.id, plan])) as Record<SelfServePlanId, PlanConfig>;

export function formatMinutesLabel(minutes: number) {
  return `${minutes.toLocaleString()} source-video minutes / month`;
}

export function formatUploadLengthLabel(minutes: number) {
  if (minutes >= 60) {
    const hours = minutes / 60;
    return `Maximum source length: ${Number.isInteger(hours) ? `${hours} hour${hours === 1 ? '' : 's'}` : `${minutes} minutes`}`;
  }
  return `Maximum source length: ${minutes} minutes`;
}

export function formatGeneratedClipsLabel(clips: number) {
  return `Up to ${clips} generated clips per source video`;
}

export function buildPlanFeatures(plan: PlanConfig) {
  return [
    formatMinutesLabel(plan.processingMinutes),
    formatUploadLengthLabel(plan.maxUploadLengthMinutes),
    formatGeneratedClipsLabel(plan.maxGeneratedClips),
    `Additional source-video minutes: $${EXTRA_USAGE_PRICE_PER_MINUTE.toFixed(2)} per minute`,
    ...(plan.featureLabels ?? []),
  ];
}
