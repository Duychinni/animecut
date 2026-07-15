import { createAdminClient } from '@/lib/supabase/admin';
import { getRequiredClipCount } from '@/lib/clip-policy';

export async function ensurePipelineJob(projectId: string) {
  const supabase = createAdminClient();

  const { data: project } = await supabase
    .from('projects')
    .select('status, pipeline_status, pipeline_completed_at, source_duration_seconds, exports(status, output_storage_path)')
    .eq('id', projectId)
    .maybeSingle();
  const savedExports = Array.isArray(project?.exports)
    ? project.exports as Array<{ status?: string | null; output_storage_path?: string | null }>
    : [];
  const hasPlayableOutput = savedExports.some((row) => row.status !== 'error'
    && typeof row.output_storage_path === 'string'
    && row.output_storage_path.length > 0
    && !row.output_storage_path.startsWith('mock://'));
  const playableOutputCount = savedExports.filter((row) => row.status !== 'error'
    && typeof row.output_storage_path === 'string'
    && row.output_storage_path.length > 0
    && !row.output_storage_path.startsWith('mock://')).length;
  const sourceDurationSeconds = Math.max(0, Number(project?.source_duration_seconds ?? 0));
  const requiredOutputCount = sourceDurationSeconds > 0 ? getRequiredClipCount(sourceDurationSeconds) : 1;
  const completionLatched = project?.status === 'completed'
    || project?.pipeline_status === 'completed'
    || Boolean(project?.pipeline_completed_at);

  if (completionLatched && hasPlayableOutput && playableOutputCount >= requiredOutputCount) {
    return { id: `completed:${projectId}`, status: 'completed' };
  }

  if (completionLatched && hasPlayableOutput && playableOutputCount < requiredOutputCount) {
    console.warn('[pipeline/job] reopening-underproduced-project', {
      projectId,
      sourceDurationSeconds,
      playableOutputCount,
      requiredOutputCount,
    });
  }

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
      status: completionLatched ? 'analyzed' : project?.status,
      pipeline_status: 'queued',
      pipeline_error: null,
      pipeline_started_at: new Date().toISOString(),
      pipeline_completed_at: null,
      updated_at: new Date().toISOString(),
    })
    .eq('id', projectId);

  return data;
}
