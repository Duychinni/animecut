import { createAdminClient } from '@/lib/supabase/admin';

export async function ensurePipelineJob(projectId: string) {
  const supabase = createAdminClient();

  const { data: existing, error: existingError } = await supabase
    .from('jobs')
    .select('id, status')
    .eq('project_id', projectId)
    .eq('type', 'pipeline')
    .in('status', ['queued', 'processing'])
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (existingError) throw existingError;
  if (existing) {
    console.log('[pipeline/job] existing', { projectId, jobId: existing.id, status: existing.status });
    return existing;
  }

  const { data, error } = await supabase
    .from('jobs')
    .insert({
      project_id: projectId,
      type: 'pipeline',
      payload: { project_id: projectId },
      status: 'queued',
    })
    .select('id, status')
    .single();

  if (error) throw error;

  console.log('[pipeline/job] created', { projectId, jobId: data.id, status: data.status });

  await supabase
    .from('projects')
    .update({
      pipeline_status: 'queued',
      pipeline_error: null,
      pipeline_started_at: new Date().toISOString(),
      pipeline_completed_at: null,
      updated_at: new Date().toISOString(),
    })
    .eq('id', projectId);

  return data;
}
