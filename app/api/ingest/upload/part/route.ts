import { NextResponse } from 'next/server';
import { createSignedMultipartPartUrl, getR2Config } from '@/lib/r2';

export async function POST(req: Request) {
  try {
    const body = (await req.json()) as { uploadId?: string; objectPath?: string; partNumber?: number };
    const uploadId = String(body.uploadId || '');
    const objectPath = String(body.objectPath || '');
    const partNumber = Number(body.partNumber || 0);

    if (!uploadId || !objectPath || !partNumber) {
      return NextResponse.json({ error: 'uploadId, objectPath, and partNumber are required' }, { status: 400 });
    }

    const cfg = getR2Config();
    if (!cfg) {
      return NextResponse.json({ error: 'R2 is not configured yet. Add R2 env vars before enabling multipart uploads.' }, { status: 400 });
    }

    const uploadUrl = await createSignedMultipartPartUrl(objectPath, uploadId, partNumber);

    console.log('[ingest/upload/part] signed part url', {
      objectPath,
      uploadId,
      partNumber,
    });

    return NextResponse.json({
      provider: 'r2-multipart',
      uploadUrl,
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
