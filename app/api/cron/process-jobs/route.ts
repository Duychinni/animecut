import { NextResponse } from 'next/server';
import { processJobs } from '@/workers/processJobs';

export async function GET(req: Request) {
  const auth = req.headers.get('authorization') || '';
  const token = auth.replace('Bearer ', '');

  if (!process.env.CRON_SECRET || token !== process.env.CRON_SECRET) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const data = await processJobs();
  return NextResponse.json({ ok: true, data });
}
