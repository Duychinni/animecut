import { NextResponse } from 'next/server';
import { readMultipartSession, getR2Config } from '@/lib/r2';

export async function POST(req: Request) {
  try {
    const body = (await req.json()) as { sessionId?: string; partNumber?: number };
    const sessionId = String(body.sessionId || '');
    const partNumber = Number(body.partNumber || 0);

    if (!sessionId || !partNumber) {
      return NextResponse.json({ error: 'sessionId and partNumber are required' }, { status: 400 });
    }

    const cfg = getR2Config();
    if (!cfg) {
      return NextResponse.json({ error: 'R2 is not configured yet. Add R2 env vars before enabling multipart uploads.' }, { status: 400 });
    }

    const session = readMultipartSession(sessionId);
    if (!session) {
      return NextResponse.json({ error: 'Upload session not found or expired' }, { status: 404 });
    }

    return NextResponse.json({
      provider: 'r2-multipart',
      uploadUrl: `${cfg.endpoint}/${cfg.bucket}/${session.key}?partNumber=${partNumber}&uploadId=${session.uploadId}`,
      method: 'PUT',
      headers: {
        'content-type': 'application/octet-stream',
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Could not create multipart part URL';
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
