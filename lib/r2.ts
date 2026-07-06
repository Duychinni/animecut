import crypto from 'node:crypto';

type R2Config = {
  accountId: string;
  accessKeyId: string;
  secretAccessKey: string;
  bucket: string;
  endpoint: string;
  publicBaseUrl: string | null;
};

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

export type R2MultipartSession = {
  key: string;
  uploadId: string;
};

const multipartSessions = new Map<string, R2MultipartSession>();

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
