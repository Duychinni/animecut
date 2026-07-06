import { NextResponse } from 'next/server';
import { completeR2MultipartUpload, getR2Config } from '@/lib/r2';

export async function POST(req: Request) {
  try {
    const body = (await req.json()) as {
      uploadId?: string;
      objectPath?: string;
      parts?: Array<{ partNumber: number; etag: string }>;
    };
    const uploadId = String(body.uploadId || '');
    const objectPath = String(body.objectPath || '');
    const parts = Array.isArray(body.parts) ? body.parts : [];

    if (!uploadId || !objectPath) {
      return NextResponse.json({ error: 'uploadId and objectPath are required' }, { status: 400 });
    }
    if (!parts.length) {
      return NextResponse.json({ error: 'At least one uploaded part is required' }, { status: 400 });
    }

    const cfg = getR2Config();
    if (!cfg) {
      return NextResponse.json({ error: 'R2 is not configured yet. Add R2 env vars before enabling multipart uploads.' }, { status: 400 });
    }

    console.log('[ingest/upload/complete] completing multipart upload', {
      objectPath,
      uploadId,
      partCount: parts.length,
    });

    await completeR2MultipartUpload({
      key: objectPath,
      uploadId,
      parts,
    });

    console.log('[ingest/upload/complete] completed multipart upload', {
      objectPath,
      uploadId,
      partCount: parts.length,
    });

    return NextResponse.json({
      ok: true,
      provider: 'r2-multipart',
      objectPath,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Could not complete multipart upload';
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
