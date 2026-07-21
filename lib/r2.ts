import {
  CompleteMultipartUploadCommand,
  CreateMultipartUploadCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
  UploadPartCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import crypto from 'node:crypto';

type R2Config = {
  accountId: string;
  accessKeyId: string;
  secretAccessKey: string;
  bucket: string;
  endpoint: string;
  publicBaseUrl: string | null;
};

export type R2MultipartSession = {
  key: string;
  uploadId: string;
};

const multipartSessions = new Map<string, R2MultipartSession>();
let cachedClient: S3Client | null = null;

export function getR2Config(): R2Config | null {
  const accountId = process.env.R2_ACCOUNT_ID;
  const accessKeyId = process.env.R2_ACCESS_KEY_ID;
  const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY;
  const bucket = process.env.R2_BUCKET;

  if (!accountId || !accessKeyId || !secretAccessKey || !bucket) {
    return null;
  }

  const endpoint = process.env.R2_ENDPOINT || `https://${accountId}.r2.cloudflarestorage.com`;
  const publicBaseUrl = process.env.R2_PUBLIC_BASE_URL || null;

  return {
    accountId,
    accessKeyId,
    secretAccessKey,
    bucket,
    endpoint,
    publicBaseUrl,
  };
}

export function isR2Configured() {
  return !!getR2Config();
}

export function getUploadProvider() {
  const provider = process.env.UPLOAD_PROVIDER || 'supabase';
  if (provider === 'r2' && isR2Configured()) return 'r2';
  return 'supabase';
}

export function makeR2ObjectUrl(objectPath: string) {
  const cfg = getR2Config();
  if (!cfg) throw new Error('R2 is not configured');
  if (cfg.publicBaseUrl) return `${cfg.publicBaseUrl.replace(/\/$/, '')}/${objectPath}`;
  return `${cfg.endpoint}/${cfg.bucket}/${objectPath}`;
}

export function createMultipartSessionId() {
  return crypto.randomUUID();
}

export function storeMultipartSession(sessionId: string, session: R2MultipartSession) {
  multipartSessions.set(sessionId, session);
}

export function readMultipartSession(sessionId: string) {
  return multipartSessions.get(sessionId) || null;
}

export function deleteMultipartSession(sessionId: string) {
  multipartSessions.delete(sessionId);
}

export function getR2Client() {
  if (cachedClient) return cachedClient;
  const cfg = getR2Config();
  if (!cfg) throw new Error('R2 is not configured. Add R2 env vars before enabling multipart uploads.');

  cachedClient = new S3Client({
    region: 'auto',
    endpoint: cfg.endpoint,
    forcePathStyle: true,
    credentials: {
      accessKeyId: cfg.accessKeyId,
      secretAccessKey: cfg.secretAccessKey,
    },
  });

  return cachedClient;
}

export async function createR2MultipartUpload(key: string, contentType: string) {
  const cfg = getR2Config();
  if (!cfg) throw new Error('R2 is not configured');
  const client = getR2Client();

  try {
    const result = await client.send(
      new CreateMultipartUploadCommand({
        Bucket: cfg.bucket,
        Key: key,
        ContentType: contentType || 'application/octet-stream',
      }),
    );

    if (!result.UploadId) throw new Error('Could not create multipart upload');
    return result.UploadId;
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    throw new Error(`R2 multipart init failed for bucket "${cfg.bucket}" at "${cfg.endpoint}". ${message}`);
  }
}

export async function createSignedMultipartPartUrl(key: string, uploadId: string, partNumber: number) {
  const cfg = getR2Config();
  if (!cfg) throw new Error('R2 is not configured');
  const client = getR2Client();

  return getSignedUrl(
    client,
    new UploadPartCommand({
      Bucket: cfg.bucket,
      Key: key,
      UploadId: uploadId,
      PartNumber: partNumber,
    }),
    { expiresIn: 60 * 60 },
  );
}

export async function completeR2MultipartUpload(params: {
  key: string;
  uploadId: string;
  parts: Array<{ partNumber: number; etag: string }>;
}) {
  const cfg = getR2Config();
  if (!cfg) throw new Error('R2 is not configured');
  const client = getR2Client();

  try {
    await client.send(
      new CompleteMultipartUploadCommand({
        Bucket: cfg.bucket,
        Key: params.key,
        UploadId: params.uploadId,
        MultipartUpload: {
          Parts: params.parts.map((part) => ({ ETag: part.etag, PartNumber: part.partNumber })),
        },
      }),
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    throw new Error(`R2 multipart completion failed for key "${params.key}". ${message}`);
  }
}

export async function createSignedR2GetUrl(key: string, expiresIn = 60 * 60 * 24 * 7) {
  const cfg = getR2Config();
  if (!cfg) throw new Error('R2 is not configured');
  const client = getR2Client();
  return getSignedUrl(client, new GetObjectCommand({ Bucket: cfg.bucket, Key: key }), { expiresIn });
}

export async function deleteR2Object(key: string) {
  const cfg = getR2Config();
  if (!cfg) throw new Error('R2 is not configured');
  const client = getR2Client();
  await client.send(new DeleteObjectCommand({ Bucket: cfg.bucket, Key: key }));
}

function previewBucket() {
  const cfg = getR2Config();
  if (!cfg) throw new Error('R2 is not configured');
  return process.env.R2_PREVIEW_BUCKET?.trim() || cfg.bucket;
}

export async function deleteR2PreviewObject(key: string) {
  await getR2Client().send(new DeleteObjectCommand({ Bucket: previewBucket(), Key: key }));
}

export async function uploadR2Object(key: string, bytes: Buffer, contentType: string, cacheControl = 'public, max-age=31536000, immutable') {
  const cfg = getR2Config();
  if (!cfg) throw new Error('R2 is not configured');
  await getR2Client().send(new PutObjectCommand({
    Bucket: cfg.bucket,
    Key: key,
    Body: bytes,
    ContentType: contentType,
    CacheControl: cacheControl,
  }));
}

export async function uploadR2PreviewObject(key: string, bytes: Buffer, contentType: string, cacheControl = 'public, max-age=31536000, immutable') {
  await getR2Client().send(new PutObjectCommand({
    Bucket: previewBucket(), Key: key, Body: bytes, ContentType: contentType, CacheControl: cacheControl,
  }));
}

export function createR2PublicUrl(key: string) {
  const cfg = getR2Config();
  if (!cfg?.publicBaseUrl) return null;
  return `${cfg.publicBaseUrl.replace(/\/$/, '')}/${key.split('/').map(encodeURIComponent).join('/')}`;
}

export async function r2ObjectExists(key: string) {
  const cfg = getR2Config();
  if (!cfg) throw new Error('R2 is not configured');
  const client = getR2Client();

  try {
    await client.send(new HeadObjectCommand({ Bucket: cfg.bucket, Key: key }));
    return true;
  } catch {
    return false;
  }
}

export async function r2PreviewObjectExists(key: string) {
  try {
    await getR2Client().send(new HeadObjectCommand({ Bucket: previewBucket(), Key: key }));
    return true;
  } catch {
    return false;
  }
}
