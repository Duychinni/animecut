type MultipartPreparation = {
  provider: 'r2-multipart';
  sessionId: string;
  partSize: number;
  partUrl: string;
  completeUrl: string;
};

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
      body: JSON.stringify({ sessionId: prep.sessionId, partNumber }),
    });
    const partData = await partRes.json();
    if (!partRes.ok) {
      throw new Error(partData?.error || 'Could not prepare multipart upload part');
    }

    const uploadRes = await fetch(partData.uploadUrl, {
      method: partData.method || 'PUT',
      headers: partData.headers || { 'content-type': 'application/octet-stream' },
      body: blob,
    });

    if (!uploadRes.ok) {
      const errText = await uploadRes.text().catch(() => 'Multipart upload failed');
      throw new Error(errText || 'Multipart upload failed');
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
    body: JSON.stringify({ sessionId: prep.sessionId, parts: completedParts }),
  });
  const completeData = await completeRes.json();
  if (!completeRes.ok) {
    throw new Error(completeData?.error || 'Could not complete multipart upload');
  }

  return completeData;
}
