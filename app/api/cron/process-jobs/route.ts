import { NextResponse } from 'next/server';

export async function GET(req: Request) {
  const auth = req.headers.get('authorization') || '';
  const token = auth.replace('Bearer ', '');

  if (!process.env.CRON_SECRET || token !== process.env.CRON_SECRET) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const base = process.env.APP_URL || new URL(req.url).origin;
  const res = await fetch(`${base}/api/jobs/process`, { method: 'POST' });
  const data = await res.json();
  return NextResponse.json({ ok: true, data });
}
