import { NextResponse } from 'next/server';
import { cleanupTmpRootOlderThan, summarizeCleanup } from '@/lib/cleanup';

export async function GET(req: Request) {
  const auth = req.headers.get('authorization') || '';
  const token = auth.replace('Bearer ', '');

  if (!process.env.CRON_SECRET || token !== process.env.CRON_SECRET) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const result = await cleanupTmpRootOlderThan(24);
  const summary = summarizeCleanup(result);
  console.log('[cleanup] daily-temp-cleanup', summary);
  return NextResponse.json({ ok: true, data: summary });
}
