export type BillingInterval = 'monthly' | 'yearly';
export type PlanId = 'free' | 'starter' | 'pro' | 'business';

export const FREE_TRIAL_UPLOADS = 1;
export const FREE_TRIAL_MAX_UPLOAD_MINUTES = 20;

export type PlanConfig = {
  id: Exclude<PlanId, 'free'>;
  name: string;
  subtitle: string;
  monthlyPrice: string;
  yearlyPrice?: string;
  yearlyBadge?: string;
  highlighted?: boolean;
  processingMinutes: number | null;
  maxUploadLengthMinutes: number | null;
  maxGeneratedClips: number | null;
  featureLabels?: string[];
  cta: string;
  secondaryCta?: string;
  isSalesOnly?: boolean;
};

export const PLAN_CONFIG: PlanConfig[] = [
  {
    id: 'starter',
    name: 'Starter',
    subtitle: 'For creators testing short-form repurposing',
    monthlyPrice: '$14.99',
    yearlyPrice: '$144',
    yearlyBadge: 'Save 20%',
    processingMinutes: 300,
    maxUploadLengthMinutes: 60,
    maxGeneratedClips: 15,
    featureLabels: ['HD exports', 'Premium captions', 'Speaker detection', 'No watermark'],
    cta: 'Choose Starter',
    secondaryCta: 'Then upgrade when you like the results',
  },
  {
    id: 'pro',
    name: 'Pro',
    subtitle: 'For serious creators, marketers, and power users',
    monthlyPrice: '$29.99',
    yearlyPrice: '$288',
    yearlyBadge: 'Save 20%',
    highlighted: true,
    processingMinutes: 800,
    maxUploadLengthMinutes: 180,
    maxGeneratedClips: 25,
    featureLabels: ['Priority processing', 'Advanced AI scoring', 'Caption presets', 'Priority queue'],
    cta: 'Get Started',
    secondaryCta: 'Best for consistent weekly clip output',
  },
  {
    id: 'business',
    name: 'Contact Us',
    subtitle: 'For teams, agencies, and high-volume workflows',
    monthlyPrice: "Let's Talk",
    processingMinutes: null,
    maxUploadLengthMinutes: null,
    maxGeneratedClips: null,
    featureLabels: ['Dedicated infrastructure', 'API access', 'Team members', 'Priority support'],
    cta: 'Contact Sales',
    secondaryCta: 'Need higher limits? Let’s talk.',
    isSalesOnly: true,
  },
];

export const PLAN_LOOKUP = Object.fromEntries(PLAN_CONFIG.map((plan) => [plan.id, plan])) as Record<Exclude<PlanId, 'free'>, PlanConfig>;

export function formatMinutesLabel(minutes: number | null) {
  if (minutes == null) return 'Custom processing minutes';
  return `${minutes} AI Processing Minutes / Month`;
}

export function formatUploadLengthLabel(minutes: number | null) {
  if (minutes == null) return 'Custom upload limits';
  if (minutes >= 60) {
    const hours = minutes / 60;
    return `Maximum upload length: ${Number.isInteger(hours) ? `${hours} hour${hours === 1 ? '' : 's'}` : `${minutes} minutes`}`;
  }
  return `Maximum upload length: ${minutes} minutes`;
}

export function formatGeneratedClipsLabel(clips: number | null) {
  if (clips == null) return 'Custom generated clip limits';
  return `Maximum generated clips: ${clips} per upload`;
}

export function buildPlanFeatures(plan: PlanConfig) {
  const base = [] as string[];

  if (plan.id !== 'business') {
    base.push(`1 free video up to ${FREE_TRIAL_MAX_UPLOAD_MINUTES} minutes to test the product first`);
  }

  base.push(formatMinutesLabel(plan.processingMinutes));
  base.push(formatUploadLengthLabel(plan.maxUploadLengthMinutes));
  base.push(formatGeneratedClipsLabel(plan.maxGeneratedClips));

  if (plan.featureLabels?.length) {
    base.push(...plan.featureLabels);
  }

  if (plan.id === 'business') {
    base.push('Need higher limits? Let’s talk.');
  }

  return base;
}
