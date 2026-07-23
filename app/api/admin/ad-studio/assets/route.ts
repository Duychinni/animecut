import { NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/admin-auth';
import { AD_ASSET_CATEGORIES, isAdAssetCategory } from '@/lib/ad-studio-assets';
import { AD_STUDIO_MAX_UPLOAD_BYTES, isAllowedAdStudioUpload } from '@/lib/ad-studio-upload';
import { createAdminClient } from '@/lib/supabase/admin';

const BUCKET = 'raw-media';

function assetRoot(userId: string) {
  return `${userId}/ad-assets`;
}

function safeAssetPath(userId: string, value: unknown) {
  const candidate = String(value || '');
  return candidate.startsWith(`${assetRoot(userId)}/`) && !candidate.includes('..') ? candidate : null;
}

function encodeName(name: string) {
  return Buffer.from(name.trim().slice(0, 180) || 'recording.mp4').toString('base64url');
}

function decodeName(objectName: string) {
  const encoded = objectName.split('--', 2)[1];
  if (!encoded) return objectName;
  try {
    return Buffer.from(encoded, 'base64url').toString('utf8');
  } catch {
    return objectName;
  }
}

export async function GET() {
  const adminUser = await requireAdmin();
  if (!adminUser) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const admin = createAdminClient();
  const assets = [];
  for (const category of AD_ASSET_CATEGORIES) {
    const directory = `${assetRoot(adminUser.id)}/${category}`;
    const { data, error } = await admin.storage.from(BUCKET).list(directory, {
      limit: 500,
      sortBy: { column: 'created_at', order: 'desc' },
    });
    if (error) throw error;
    for (const item of data || []) {
      if (!item.id) continue;
      const objectPath = `${directory}/${item.name}`;
      const { data: signed, error: signedError } = await admin.storage.from(BUCKET).createSignedUrl(objectPath, 60 * 60);
      if (signedError) throw signedError;
      assets.push({
        id: item.id,
        path: objectPath,
        name: decodeName(item.name),
        category,
        contentType: String(item.metadata?.mimetype || item.metadata?.contentType || 'video/mp4'),
        size: Number(item.metadata?.size || 0),
        createdAt: item.created_at || null,
        previewUrl: signed.signedUrl,
      });
    }
  }
  return NextResponse.json({ assets }, { headers: { 'Cache-Control': 'no-store' } });
}

export async function POST(request: Request) {
  const adminUser = await requireAdmin();
  if (!adminUser) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const body = await request.json() as { name?: string; contentType?: string; size?: number; category?: string };
  const name = String(body.name || '');
  const contentType = String(body.contentType || 'application/octet-stream');
  const size = Number(body.size || 0);
  const category = String(body.category || '');

  if (!isAllowedAdStudioUpload({ name, type: contentType })) {
    return NextResponse.json({ error: 'Choose an OBS video in MP4, MOV, WebM, MKV, or FLV format.' }, { status: 415 });
  }
  if (!Number.isFinite(size) || size <= 0 || size > AD_STUDIO_MAX_UPLOAD_BYTES) {
    return NextResponse.json({ error: 'Each uploaded video must be under 300 MB.' }, { status: 413 });
  }
  if (!isAdAssetCategory(category)) return NextResponse.json({ error: 'Choose a valid asset category.' }, { status: 400 });

  const objectPath = `${assetRoot(adminUser.id)}/${category}/${crypto.randomUUID()}--${encodeName(name)}`;
  const admin = createAdminClient();
  const { data, error } = await admin.storage.from(BUCKET).createSignedUploadUrl(objectPath);
  if (error) throw error;
  return NextResponse.json({
    path: objectPath,
    uploadUrl: data.signedUrl,
    headers: { 'content-type': contentType || 'application/octet-stream' },
  });
}

export async function PATCH(request: Request) {
  const adminUser = await requireAdmin();
  if (!adminUser) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const body = await request.json() as { path?: string; name?: string; category?: string };
  const sourcePath = safeAssetPath(adminUser.id, body.path);
  const name = String(body.name || '').trim();
  const category = String(body.category || '');
  if (!sourcePath || !name || !isAdAssetCategory(category)) {
    return NextResponse.json({ error: 'Asset, name, and category are required.' }, { status: 400 });
  }
  const objectName = sourcePath.split('/').pop() || '';
  const id = objectName.split('--', 1)[0] || crypto.randomUUID();
  const targetPath = `${assetRoot(adminUser.id)}/${category}/${id}--${encodeName(name)}`;
  const admin = createAdminClient();
  if (targetPath !== sourcePath) {
    const { error } = await admin.storage.from(BUCKET).move(sourcePath, targetPath);
    if (error) throw error;
  }
  return NextResponse.json({ ok: true, path: targetPath });
}

export async function DELETE(request: Request) {
  const adminUser = await requireAdmin();
  if (!adminUser) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const body = await request.json() as { path?: string };
  const objectPath = safeAssetPath(adminUser.id, body.path);
  if (!objectPath) return NextResponse.json({ error: 'Choose a valid asset.' }, { status: 400 });
  const admin = createAdminClient();
  const { error } = await admin.storage.from(BUCKET).remove([objectPath]);
  if (error) throw error;
  return NextResponse.json({ ok: true });
}
