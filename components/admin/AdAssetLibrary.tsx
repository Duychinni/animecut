'use client';

import { useCallback, useEffect, useState } from 'react';
import { AD_ASSET_CATEGORIES, AD_ASSET_CATEGORY_LABELS, type AdAsset, type AdAssetCategory } from '@/lib/ad-studio-assets';
import { AD_STUDIO_MAX_UPLOAD_BYTES, AD_STUDIO_UPLOAD_ACCEPT, isAllowedAdStudioUpload } from '@/lib/ad-studio-upload';

type Props = {
  selectedPaths: string[];
  onSelectionChange: (assets: AdAsset[]) => void;
};

export function AdAssetLibrary({ selectedPaths, onSelectionChange }: Props) {
  const [assets, setAssets] = useState<AdAsset[]>([]);
  const [category, setCategory] = useState<AdAssetCategory>('product-demo');
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState('');
  const [error, setError] = useState('');

  const loadAssets = useCallback(async () => {
    const response = await fetch('/api/admin/ad-studio/assets', { cache: 'no-store' });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error || 'Could not load ad assets');
    setAssets(payload.assets || []);
  }, []);

  useEffect(() => {
    void loadAssets().catch((reason) => setError(reason instanceof Error ? reason.message : 'Could not load ad assets'));
  }, [loadAssets]);

  function toggleAsset(asset: AdAsset) {
    const next = selectedPaths.includes(asset.path)
      ? assets.filter((item) => selectedPaths.includes(item.path) && item.path !== asset.path)
      : [...assets.filter((item) => selectedPaths.includes(item.path)), asset];
    onSelectionChange(next);
  }

  async function uploadFiles(files: File[]) {
    setError('');
    if (!files.length) return;
    const invalid = files.find((file) => !isAllowedAdStudioUpload(file));
    if (invalid) return setError(`${invalid.name} must be MP4, MOV, WebM, MKV, or FLV.`);
    const oversized = files.find((file) => file.size > AD_STUDIO_MAX_UPLOAD_BYTES);
    if (oversized) return setError(`${oversized.name} is over the 300 MB limit.`);

    setBusy(true);
    try {
      for (const [index, file] of files.entries()) {
        setStatus(`Uploading ${index + 1} of ${files.length}: ${file.name}`);
        const prepare = await fetch('/api/admin/ad-studio/assets', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ name: file.name, contentType: file.type, size: file.size, category }),
        });
        const target = await prepare.json();
        if (!prepare.ok) throw new Error(target.error || `Could not prepare ${file.name}`);
        const upload = await fetch(target.uploadUrl, { method: 'PUT', headers: target.headers, body: file });
        if (!upload.ok) throw new Error(`Storage upload failed for ${file.name}`);
      }
      setStatus('Upload complete');
      await loadAssets();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Upload failed');
    } finally {
      setBusy(false);
      window.setTimeout(() => setStatus(''), 2500);
    }
  }

  async function updateAsset(asset: AdAsset, updates: { name?: string; category?: AdAssetCategory }) {
    const response = await fetch('/api/admin/ad-studio/assets', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path: asset.path, name: updates.name || asset.name, category: updates.category || asset.category }),
    });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error || 'Could not update asset');
    onSelectionChange([]);
    await loadAssets();
  }

  async function deleteAsset(asset: AdAsset) {
    if (!window.confirm(`Delete "${asset.name}" from the Ad Asset Library?`)) return;
    const response = await fetch('/api/admin/ad-studio/assets', {
      method: 'DELETE',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path: asset.path }),
    });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error || 'Could not delete asset');
    onSelectionChange(assets.filter((item) => selectedPaths.includes(item.path) && item.path !== asset.path));
    await loadAssets();
  }

  return (
    <section className="mt-8 rounded-3xl border border-white/10 bg-white/[0.035] p-5 sm:p-7">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h2 className="text-xl font-black">Ad Asset Library</h2>
          <p className="mt-1 text-sm text-white/50">Upload recordings once, organize them, and reuse them in future AI ad projects.</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <select value={category} onChange={(event) => setCategory(event.target.value as AdAssetCategory)} className="rounded-xl border border-white/10 bg-black/30 px-3 py-2 text-sm text-white">
            {AD_ASSET_CATEGORIES.map((value) => <option key={value} value={value}>{AD_ASSET_CATEGORY_LABELS[value]}</option>)}
          </select>
          <label className={`cursor-pointer rounded-xl bg-white px-4 py-2 text-sm font-black text-black ${busy ? 'pointer-events-none opacity-50' : ''}`}>
            Upload videos
            <input type="file" multiple accept={AD_STUDIO_UPLOAD_ACCEPT} className="sr-only" onChange={(event) => void uploadFiles(Array.from(event.target.files || []))} />
          </label>
        </div>
      </div>

      {status ? <p className="mt-4 text-sm font-semibold text-[#9affb1]">{status}</p> : null}
      {error ? <p className="mt-4 rounded-xl border border-red-400/25 bg-red-400/10 px-4 py-3 text-sm text-red-100">{error}</p> : null}

      {assets.length === 0 ? (
        <div className="mt-6 rounded-2xl border border-dashed border-white/15 px-5 py-10 text-center text-sm text-white/40">No assets yet. Choose a category, then upload your OBS recordings.</div>
      ) : (
        <div className="mt-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {assets.map((asset) => {
            const selected = selectedPaths.includes(asset.path);
            return (
              <article key={asset.path} className={`overflow-hidden rounded-2xl border bg-black/25 ${selected ? 'border-[#ff63c3]/70 ring-1 ring-[#ff63c3]/35' : 'border-white/10'}`}>
                <button type="button" onClick={() => toggleAsset(asset)} className="block w-full text-left">
                  <video src={asset.previewUrl} preload="metadata" muted controls className="aspect-video w-full bg-black object-contain" onClick={(event) => event.stopPropagation()} />
                  <div className="p-3">
                    <p className="truncate text-sm font-bold text-white">{asset.name}</p>
                    <p className="mt-1 text-xs text-white/40">{AD_ASSET_CATEGORY_LABELS[asset.category]} · {(asset.size / 1024 / 1024).toFixed(1)} MB</p>
                    <p className={`mt-2 text-xs font-bold ${selected ? 'text-[#ff8ddb]' : 'text-white/45'}`}>{selected ? '✓ Selected for ad' : 'Select for ad'}</p>
                  </div>
                </button>
                <div className="flex gap-3 border-t border-white/10 px-3 py-2 text-xs">
                  <button type="button" onClick={() => {
                    const name = window.prompt('Rename asset', asset.name);
                    if (name?.trim()) void updateAsset(asset, { name: name.trim() }).catch((reason) => setError(reason.message));
                  }} className="text-white/55 hover:text-white">Rename</button>
                  <select value={asset.category} onChange={(event) => void updateAsset(asset, { category: event.target.value as AdAssetCategory }).catch((reason) => setError(reason.message))} className="min-w-0 flex-1 bg-transparent text-white/55">
                    {AD_ASSET_CATEGORIES.map((value) => <option key={value} value={value}>{AD_ASSET_CATEGORY_LABELS[value]}</option>)}
                  </select>
                  <button type="button" onClick={() => void deleteAsset(asset).catch((reason) => setError(reason.message))} className="text-red-300/70 hover:text-red-200">Delete</button>
                </div>
              </article>
            );
          })}
        </div>
      )}
    </section>
  );
}
