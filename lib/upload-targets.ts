import { createClient as createServerSupabaseClient } from '@/lib/supabase/server';
import { makeRawObjectPath } from '@/lib/storage';
import {
  createR2MultipartUpload,
  getUploadProvider,
  isR2Configured,
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
  uploadId: string;
  partSize: number;
  completeUrl: string;
  partUrl: string;
};

export type UploadPreparationResult = SignedUrlUploadPreparationResult | R2MultipartUploadPreparationResult;

const DEFAULT_SUPABASE_RAW_MEDIA_MAX_BYTES = 5 * 1024 * 1024 * 1024;

function getSupabaseRawMediaMaxBytes() {
  const configured = Number(process.env.SUPABASE_RAW_MEDIA_MAX_BYTES || DEFAULT_SUPABASE_RAW_MEDIA_MAX_BYTES);
  return Number.isFinite(configured) && configured > 0
    ? Math.floor(configured)
    : DEFAULT_SUPABASE_RAW_MEDIA_MAX_BYTES;
}

function getSupabaseStorageContentType(filename: string, contentType: string) {
  const extension = (filename.split('.').pop() || '').toLowerCase();
  const normalizedType = contentType.toLowerCase().split(';', 1)[0].trim();

  // Supabase validates signed uploads against the bucket MIME allow-list. Some
  // browsers label MKV files as video/matroska (or video/x-matroska), which is
  // commonly rejected even though FFmpeg supports the container. Keep the .mkv
  // object extension for media probing, but use a bucket-safe video MIME for the
  // storage request. FFmpeg identifies the input from its bytes, not this header.
  if (
    extension === 'mkv' ||
    normalizedType === 'video/matroska' ||
    normalizedType === 'video/x-matroska'
  ) {
    return 'video/mp4';
  }

  return contentType || 'application/octet-stream';
}

export async function prepareUploadTarget(input: UploadPreparationInput): Promise<UploadPreparationResult> {
  const ext = (input.filename.split('.').pop() || 'mp4').toLowerCase();
  const objectPath = makeRawObjectPath(input.userId, input.projectId, ext);

  if (getUploadProvider() === 'r2' && isR2Configured()) {
    const uploadId = await createR2MultipartUpload(objectPath, input.contentType || 'application/octet-stream');

    return {
      provider: 'r2-multipart',
      bucket: process.env.R2_BUCKET || 'raw-media',
      objectPath,
      uploadId,
      partSize: 25 * 1024 * 1024,
      completeUrl: `/api/ingest/upload/complete`,
      partUrl: `/api/ingest/upload/part`,
    };
  }

  const supabaseMaxBytes = getSupabaseRawMediaMaxBytes();
  if (typeof input.size === 'number' && input.size > supabaseMaxBytes) {
    const maxGiB = Math.round((supabaseMaxBytes / 1024 ** 3) * 10) / 10;
    throw new Error(
      `This file is larger than the ${maxGiB} GB direct-upload limit. ` +
      'Configure the R2 multipart upload provider for large source videos.',
    );
  }

  const supabase = await createServerSupabaseClient();
  const storageContentType = getSupabaseStorageContentType(input.filename, input.contentType);
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
      'content-type': storageContentType,
      'x-upsert': 'true',
    },
  };
}
