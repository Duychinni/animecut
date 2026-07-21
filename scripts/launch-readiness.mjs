import { readFile, access } from 'node:fs/promises';

const requiredFiles = [
  'app/auth/forgot-password/page.tsx',
  'app/auth/reset-password/page.tsx',
  'app/global-error.tsx',
  'instrumentation.ts',
  'instrumentation-client.ts',
  'app/api/admin/health/route.ts',
  'app/dashboard/admin/health/page.tsx',
  'components/project/ProjectFailureActions.tsx',
  'docs/LAUNCH_SUPPORT_PLAYBOOK.md',
  'supabase/migrations/0021_project_notifications.sql',
];

const failures = [];
for (const file of requiredFiles) {
  try { await access(file); } catch { failures.push(`missing ${file}`); }
}
const cleanup = await readFile('app/api/cron/cleanup-retention/route.ts', 'utf8');
if (!cleanup.includes("['queued', 'processing']") || !cleanup.includes('protectedProjectIds')) failures.push('retention cleanup does not protect active projects');
const webhook = await readFile('app/api/billing/webhook/route.ts', 'utf8');
for (const event of ['checkout.session.completed', 'customer.subscription.updated', 'customer.subscription.deleted', 'invoice.payment_failed']) {
  if (!webhook.includes(event)) failures.push(`Stripe webhook missing ${event}`);
}
if (failures.length) {
  console.error(`Launch readiness failed:\n- ${failures.join('\n- ')}`);
  process.exit(1);
}
console.log('Launch readiness static checks passed. Run the documented real-device and Stripe test-mode matrix before launch.');
