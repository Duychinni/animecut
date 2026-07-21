import { createAdminClient } from '@/lib/supabase/admin';

export async function sendProjectStatusEmail(projectId: string, notificationType: 'completed' | 'failed') {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) return { sent: false, reason: 'RESEND_API_KEY is not configured' };
  const admin = createAdminClient();
  const { data: project } = await admin.from('projects').select('id,user_id,title,source_title').eq('id', projectId).maybeSingle();
  if (!project?.user_id) return { sent: false, reason: 'project owner not found' };
  const { data: userResult } = await admin.auth.admin.getUserById(project.user_id);
  const recipient = userResult?.user?.email;
  if (!recipient) return { sent: false, reason: 'recipient not found' };
  const { error: reserveError } = await admin.from('project_notifications').insert({ project_id: projectId, notification_type: notificationType, recipient });
  if (reserveError) {
    if (/duplicate|unique/i.test(reserveError.message)) return { sent: false, reason: 'already sent' };
    if (/does not exist|schema cache/i.test(reserveError.message)) return { sent: false, reason: 'migration 0021 is not applied' };
    throw reserveError;
  }
  const title = String(project.source_title || project.title || 'Your project');
  const completed = notificationType === 'completed';
  const appUrl = process.env.APP_URL || process.env.NEXT_PUBLIC_APP_URL || 'https://www.animacut.com';
  const response = await fetch('https://api.resend.com/emails', { method: 'POST', headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' }, body: JSON.stringify({ from: process.env.RESEND_FROM_EMAIL || 'AnimaCut <support@animacut.com>', to: [recipient], subject: completed ? `${title} is ready` : `${title} needs your attention`, html: `<p>${completed ? 'Your AnimaCut reels are ready to preview and download.' : 'AnimaCut could not finish processing this project automatically. Your upload is still saved and you can retry it.'}</p><p><a href="${appUrl}/dashboard/projects/${projectId}">Open your project</a></p>` }) });
  if (!response.ok) {
    await admin.from('project_notifications').delete().eq('project_id', projectId).eq('notification_type', notificationType);
    throw new Error(`Resend notification failed (${response.status})`);
  }
  return { sent: true };
}
