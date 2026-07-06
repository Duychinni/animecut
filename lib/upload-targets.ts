import { createClient as createServerSupabaseClient } from '@/lib/supabase/server';
import { makeRawObjectPath } from '@/lib/storage';
import {
  createMultipartSessionId,
  createR2MultipartUpload,
  getUploadProvider,
  isR2Configured,
  storeMultipartSession,
} from '@/lib/r2';

export type UploadPreparationInput = {
  userId: string;
  projectId: string;
  filename: string;
  contentType: string;
  size?: number;
};

export type SignedUrlUploadPreparationResult = {
  provider: 'supabase-signed-url';
  bucket: string;
  objectPath: string;
  uploadUrl: string;
  method: 'PUT';
  headers: Record<string, string>;
};

export type R2MultipartUploadPreparationResult = {
  provider: 'r2-multipart';
  bucket: string;
  objectPath: string;
  sessionId: string;
  partSize: number;
  completeUrl: string;
  partUrl: string;
};

export type UploadPreparationResult = SignedUrlUploadPreparationResult | R2MultipartUploadPreparationResult;

export async function prepareUploadTarget(input: UploadPreparationInput): Promise<UploadPreparationResult> {
  const ext = (input.filename.split('.').pop() || 'mp4').toLowerCase();
  const objectPath = makeRawObjectPath(input.userId, input.projectId, ext);

  if (getUploadProvider() === 'r2' && isR2Configured()) {
    const uploadId = await createR2MultipartUpload(objectPath, input.contentType || 'application/octet-stream');
    const sessionId = createMultipartSessionId();
    storeMultipartSession(sessionId, {
      key: objectPath,
      uploadId,
    });

    return {
      provider: 'r2-multipart',
      bucket: process.env.R2_BUCKET || 'raw-media',
      objectPath,
      sessionId,
      partSize: 25 * 1024 * 1024,
      completeUrl: `/api/ingest/upload/complete`,
      partUrl: `/api/ingest/upload/part`,
    };
  }

  const supabase = await createServerSupabaseClient();
  const { data: signed, error: signedError } = await supabase.storage
    .from('raw-media')
    .createSignedUploadUrl(objectPath);

  if (signedError) throw signedError;

  return {
    provider: 'supabase-signed-url',
    bucket: 'raw-media',
    objectPath,
    uploadUrl: signed.signedUrl,
    method: 'PUT',
    headers: {
      'content-type': input.contentType || 'application/octet-stream',
      'x-upsert': 'true',
    },
  };
}
