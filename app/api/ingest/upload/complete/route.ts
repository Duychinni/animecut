import { NextResponse } from 'next/server';
import { completeR2MultipartUpload, deleteMultipartSession, getR2Config, readMultipartSession } from '@/lib/r2';

export async function POST(req: Request) {
  try {
    const body = (await req.json()) as {
      sessionId?: string;
      parts?: Array<{ partNumber: number; etag: string }>;
    };
    const sessionId = String(body.sessionId || '');
    const parts = Array.isArray(body.parts) ? body.parts : [];

    if (!sessionId) {
      return NextResponse.json({ error: 'sessionId is required' }, { status: 400 });
    }
    if (!parts.length) {
      return NextResponse.json({ error: 'At least one uploaded part is required' }, { status: 400 });
    }

    const cfg = getR2Config();
    if (!cfg) {
      return NextResponse.json({ error: 'R2 is not configured yet. Add R2 env vars before enabling multipart uploads.' }, { status: 400 });
    }

    const session = readMultipartSession(sessionId);
    if (!session) {
      return NextResponse.json({ error: 'Upload session not found or expired' }, { status: 404 });
    }

    await completeR2MultipartUpload({
      key: session.key,
      uploadId: session.uploadId,
      parts,
    });

    deleteMultipartSession(sessionId);

    return NextResponse.json({
      ok: true,
      provider: 'r2-multipart',
      objectPath: session.key,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Could not complete multipart upload';
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
