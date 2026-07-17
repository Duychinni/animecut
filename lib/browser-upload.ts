import { readJsonSafe } from '@/lib/safe-json';

type MultipartPreparation = {
  provider: 'r2-multipart';
  uploadId: string;
  objectPath: string;
  partSize: number;
  partUrl: string;
  completeUrl: string;
};

export async function getDirectUploadError(response: Response) {
  const raw = await response.text().catch(() => '');
  let message = raw;

  try {
    const parsed = JSON.parse(raw) as { message?: unknown; error?: unknown };
    message = String(parsed.message || parsed.error || raw);
  } catch {
    // Storage providers may return plain text instead of JSON.
  }

  if (
    response.status === 413 ||
    /payload too large|maximum allowed size|object exceeded|exceeded the maximum/i.test(message)
  ) {
    return 'This video exceeds the current storage upload limit. Please try a smaller file or contact support.';
  }

  return message || `Upload failed (${response.status})`;
}

export async function uploadFileMultipartToR2(file: File, prep: MultipartPreparation, onProgress?: (percent: number) => void) {
  const totalParts = Math.ceil(file.size / prep.partSize);
  const completedParts: Array<{ partNumber: number; etag: string }> = [];

  for (let index = 0; index < totalParts; index += 1) {
    const partNumber = index + 1;
    const start = index * prep.partSize;
    const end = Math.min(start + prep.partSize, file.size);
    const blob = file.slice(start, end);

    const partRes = await fetch(prep.partUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ uploadId: prep.uploadId, objectPath: prep.objectPath, partNumber }),
    });
    const partData = await readJsonSafe(partRes);
    if (!partRes.ok) {
      throw new Error(String(partData?.error || 'Could not prepare multipart upload part'));
    }

    const uploadUrl = typeof partData.uploadUrl === 'string' ? partData.uploadUrl : null;
    const uploadMethod = typeof partData.method === 'string' ? partData.method : 'PUT';
    const uploadHeaders = (partData.headers && typeof partData.headers === 'object')
      ? (partData.headers as HeadersInit)
      : { 'content-type': 'application/octet-stream' };

    if (!uploadUrl) {
      throw new Error(`Multipart upload part ${partNumber} missing upload URL`);
    }

    const uploadRes = await fetch(uploadUrl, {
      method: uploadMethod,
      headers: uploadHeaders,
      body: blob,
    });

    if (!uploadRes.ok) {
      const errText = await uploadRes.text().catch(() => 'Multipart upload failed');
      throw new Error(`Multipart upload part ${partNumber} failed: ${errText || 'Upload failed'}`);
    }

    const etag = uploadRes.headers.get('etag');
    if (!etag) {
      throw new Error('Multipart upload part succeeded but returned no ETag');
    }

    completedParts.push({ partNumber, etag });
    if (onProgress) {
      onProgress(Math.round((completedParts.length / totalParts) * 100));
    }
  }

  const completeRes = await fetch(prep.completeUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ uploadId: prep.uploadId, objectPath: prep.objectPath, parts: completedParts }),
  });
  const completeData = await readJsonSafe(completeRes);
  if (!completeRes.ok) {
    throw new Error(String(completeData?.error || 'Could not complete multipart upload'));
  }

  return completeData;
}
