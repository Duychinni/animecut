import { createAdminClient } from '@/lib/supabase/admin';
import webpush from 'web-push';

type NotificationType = 'completed' | 'failed';

export async function sendProjectStatusEmail(projectId: string, notificationType: NotificationType) {
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

export async function sendProjectStatusPush(projectId: string, notificationType: NotificationType) {
  const publicKey = process.env.NEXT_PUBLIC_WEB_PUSH_VAPID_PUBLIC_KEY;
  const privateKey = process.env.WEB_PUSH_VAPID_PRIVATE_KEY;
  if (!publicKey || !privateKey) return { sent: 0, reason: 'VAPID keys are not configured' };

  const admin = createAdminClient();
  const { data: project } = await admin
    .from('projects')
    .select('id,user_id,title,source_title')
    .eq('id', projectId)
    .maybeSingle();
  if (!project?.user_id) return { sent: 0, reason: 'project owner not found' };

  const { data: subscriptions, error } = await admin
    .from('push_subscriptions')
    .select('id,endpoint,p256dh,auth')
    .eq('user_id', project.user_id);
  if (error) {
    if (/does not exist|schema cache/i.test(error.message)) return { sent: 0, reason: 'migration 0026 is not applied' };
    throw error;
  }
  if (!subscriptions?.length) return { sent: 0, reason: 'no subscribed devices' };

  webpush.setVapidDetails(
    process.env.WEB_PUSH_CONTACT || 'mailto:support@animacut.com',
    publicKey,
    privateKey,
  );

  const projectTitle = String(project.source_title || project.title || 'Your video');
  const completed = notificationType === 'completed';
  const payload = JSON.stringify({
    title: completed ? 'Your AnimaCut video is ready' : 'Your AnimaCut video needs attention',
    body: completed
      ? `${projectTitle} has finished processing. Your reels are ready to preview.`
      : `${projectTitle} could not finish processing. Open it to review or retry.`,
    url: `/dashboard/projects/${projectId}`,
    tag: `animacut-${projectId}-${notificationType}`,
  });

  let sent = 0;
  await Promise.all(subscriptions.map(async (subscription) => {
    const { error: reserveError } = await admin.from('project_push_notifications').insert({
      project_id: projectId,
      subscription_id: subscription.id,
      notification_type: notificationType,
    });
    if (reserveError) {
      if (/duplicate|unique/i.test(reserveError.message)) return;
      throw reserveError;
    }

    try {
      await webpush.sendNotification({
        endpoint: subscription.endpoint,
        keys: { p256dh: subscription.p256dh, auth: subscription.auth },
      }, payload, { TTL: 60 * 60 * 24 });
      sent += 1;
    } catch (pushError) {
      const statusCode = typeof pushError === 'object' && pushError && 'statusCode' in pushError
        ? Number(pushError.statusCode)
        : 0;
      if (statusCode === 404 || statusCode === 410) {
        await admin.from('push_subscriptions').delete().eq('id', subscription.id);
        return;
      }
      await admin
        .from('project_push_notifications')
        .delete()
        .eq('project_id', projectId)
        .eq('subscription_id', subscription.id)
        .eq('notification_type', notificationType);
      throw pushError;
    }
  }));

  return { sent };
}

export async function sendProjectStatusNotifications(projectId: string, notificationType: NotificationType) {
  const results = await Promise.allSettled([
    sendProjectStatusEmail(projectId, notificationType),
    sendProjectStatusPush(projectId, notificationType),
  ]);

  results.forEach((result, index) => {
    if (result.status === 'rejected') {
      console.warn(`[notification] ${index === 0 ? 'email' : 'push'} delivery failed`, {
        projectId,
        error: result.reason instanceof Error ? result.reason.message : String(result.reason),
      });
    }
  });
}
