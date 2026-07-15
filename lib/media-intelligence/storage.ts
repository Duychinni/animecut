import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { createAdminClient } from '@/lib/supabase/admin';

const ANALYSIS_BUCKET = 'analysis-artifacts';
const MAGIC = Buffer.from('ACAE1', 'ascii');
const IV_BYTES = 12;
const TAG_BYTES = 16;

function getEncryptionKey() {
  const encoded = process.env.ANALYSIS_ARTIFACT_ENCRYPTION_KEY_BASE64?.trim();
  if (!encoded) {
    throw new Error('ANALYSIS_ARTIFACT_ENCRYPTION_KEY_BASE64 is required when diarization is enabled');
  }
  const key = Buffer.from(encoded, 'base64');
  if (key.length !== 32) {
    throw new Error('ANALYSIS_ARTIFACT_ENCRYPTION_KEY_BASE64 must decode to exactly 32 bytes');
  }
  return key;
}

export function encryptArtifactForStorage(plaintext: Buffer) {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', getEncryptionKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([MAGIC, iv, tag, ciphertext]);
}

export function decryptArtifactFromStorage(payload: Buffer) {
  if (payload.length < MAGIC.length + IV_BYTES + TAG_BYTES || !payload.subarray(0, MAGIC.length).equals(MAGIC)) {
    throw new Error('Invalid encrypted analysis artifact');
  }
  const ivStart = MAGIC.length;
  const tagStart = ivStart + IV_BYTES;
  const bodyStart = tagStart + TAG_BYTES;
  const decipher = createDecipheriv('aes-256-gcm', getEncryptionKey(), payload.subarray(ivStart, tagStart));
  decipher.setAuthTag(payload.subarray(tagStart, bodyStart));
  return Buffer.concat([decipher.update(payload.subarray(bodyStart)), decipher.final()]);
}

export function makeSpeakerEmbeddingObjectPath(userId: string, projectId: string, analysisRunId: string) {
  return `${userId}/${projectId}/${analysisRunId}/speaker-embeddings.npz.enc`;
}

export async function uploadEncryptedSpeakerEmbeddings(objectPath: string, plaintext: Buffer) {
  const encrypted = encryptArtifactForStorage(plaintext);
  const admin = createAdminClient();
  const { error } = await admin.storage.from(ANALYSIS_BUCKET).upload(objectPath, encrypted, {
    upsert: true,
    contentType: 'application/octet-stream',
    cacheControl: '0',
  });
  encrypted.fill(0);
  if (error) throw error;
}

async function removeArtifactPaths(paths: string[]) {
  if (!paths.length) return;
  const admin = createAdminClient();
  for (let index = 0; index < paths.length; index += 100) {
    const batch = paths.slice(index, index + 100);
    const { error } = await admin.storage.from(ANALYSIS_BUCKET).remove(batch);
    if (error) throw error;
  }
}

export async function removeAnalysisArtifactPath(path: string) {
  await removeArtifactPaths(path ? [path] : []);
}

export async function deleteProjectAnalysisArtifacts(projectId: string) {
  const admin = createAdminClient();
  const { data, error } = await admin
    .from('speaker_embedding_artifacts')
    .select('storage_path')
    .eq('project_id', projectId)
    .is('deleted_at', null);
  if (error) {
    if (/does not exist|schema cache/i.test(error.message)) return;
    throw error;
  }
  const paths = (data ?? [])
    .map((row) => String(row.storage_path || ''))
    .filter(Boolean);
  await removeArtifactPaths(paths);
}

export async function cleanupExpiredAnalysisArtifacts(limit = 100) {
  const admin = createAdminClient();
  const now = new Date().toISOString();
  const { data, error } = await admin
    .from('speaker_embedding_artifacts')
    .select('id, storage_path')
    .is('deleted_at', null)
    .lte('expires_at', now)
    .limit(Math.max(1, Math.min(500, limit)));
  if (error) {
    if (/does not exist|schema cache/i.test(error.message)) return { deleted: 0, unavailable: true };
    throw error;
  }
  const rows = data ?? [];
  await removeArtifactPaths(rows.map((row) => String(row.storage_path)).filter(Boolean));
  if (rows.length) {
    const { error: updateError } = await admin
      .from('speaker_embedding_artifacts')
      .update({ deleted_at: now })
      .in('id', rows.map((row) => row.id));
    if (updateError) throw updateError;
  }
  return { deleted: rows.length, unavailable: false };
}
