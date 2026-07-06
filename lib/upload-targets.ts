import { createClient as createServerSupabaseClient } from '@/lib/supabase/server';
import { makeRawObjectPath } from '@/lib/storage';

export type UploadPreparationInput = {
  userId: string;
  projectId: string;
  filename: string;
  contentType: string;
  size?: number;
};

export type UploadPreparationResult = {
  provider: 'supabase-signed-url';
  bucket: string;
  objectPath: string;
  uploadUrl: string;
  method: 'PUT';
  headers: Record<string, string>;
};

export async function prepareUploadTarget(input: UploadPreparationInput): Promise<UploadPreparationResult> {
  const ext = (input.filename.split('.').pop() || 'mp4').toLowerCase();
  const objectPath = makeRawObjectPath(input.userId, input.projectId, ext);

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
