import { createAdminClient } from '@/lib/supabase/admin';
import { effectivePlanId } from '@/lib/billing';
import { PLAN_LOOKUP, type PlanId } from '@/lib/plans';

export const PLAN_QUEUE_PRIORITY: Record<PlanId, number> = {
  free: 0,
  starter: 1,
  creator: 2,
  pro: 3,
  business: 3,
};

export async function getProjectPlanEntitlements(projectId: string) {
  const admin = createAdminClient();
  const { data: project, error: projectError } = await admin
    .from('projects')
    .select('user_id')
    .eq('id', projectId)
    .single();
  if (projectError || !project?.user_id) throw projectError ?? new Error('Project owner not found');

  const { data: profile, error: profileError } = await admin
    .from('profiles')
    .select('subscription_plan, subscription_status')
    .eq('id', project.user_id)
    .single();
  if (profileError || !profile) throw profileError ?? new Error('Project owner profile not found');

  const planId = effectivePlanId(profile) as PlanId;
  const plan = planId === 'starter' || planId === 'creator' || planId === 'pro'
    ? PLAN_LOOKUP[planId]
    : null;

  return {
    planId,
    maxGeneratedClips: plan?.maxGeneratedClips ?? 12,
    queuePriority: PLAN_QUEUE_PRIORITY[planId],
    hasCaptionPresets: planId === 'creator' || planId === 'pro' || planId === 'business',
    hasAdvancedClipScoring: planId === 'creator' || planId === 'pro' || planId === 'business',
  };
}

export async function sortProjectWorkByPlan<T extends { projectId: string; createdAt?: string | null }>(items: T[]) {
  if (items.length < 2) return items;
  const projectIds = [...new Set(items.map((item) => item.projectId))];
  const admin = createAdminClient();
  const { data: projects } = await admin.from('projects').select('id, user_id').in('id', projectIds);
  const userIds = [...new Set((projects ?? []).map((row) => String(row.user_id)))];
  const { data: profiles } = userIds.length
    ? await admin.from('profiles').select('id, subscription_plan, subscription_status').in('id', userIds)
    : { data: [] };
  const planByUser = new Map((profiles ?? []).map((row) => [String(row.id), effectivePlanId(row) as PlanId]));
  const userByProject = new Map((projects ?? []).map((row) => [String(row.id), String(row.user_id)]));

  return [...items].sort((a, b) => {
    const aPlan = planByUser.get(userByProject.get(a.projectId) ?? '') ?? 'free';
    const bPlan = planByUser.get(userByProject.get(b.projectId) ?? '') ?? 'free';
    const priorityDifference = PLAN_QUEUE_PRIORITY[bPlan] - PLAN_QUEUE_PRIORITY[aPlan];
    if (priorityDifference) return priorityDifference;
    return String(a.createdAt ?? '').localeCompare(String(b.createdAt ?? ''));
  });
}
