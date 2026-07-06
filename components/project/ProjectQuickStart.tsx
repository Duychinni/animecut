'use client';

import { useState } from 'react';

type ProjectCreatedPayload = {
  id: string;
  title: string;
  source_type: 'youtube' | 'upload';
  source_url?: string;
};

type Props = {
  compact?: boolean;
  onProjectCreated?: (project: ProjectCreatedPayload) => void;
};

function makeProjectTitle() {
  return 'MAIN PROJECTS';
}

export function ProjectQuickStart({ compact = false, onProjectCreated }: Props) {
  const [sourceUrl, setSourceUrl] = useState('');
  const [loading, setLoading] = useState(false);
  const [msg, setMsg] = useState('');
  const [uploadProgress, setUploadProgress] = useState(0);

  async function createProject(input: { title: string; source_type: 'youtube' | 'upload'; source_url?: string }) {
    const res = await fetch('/api/projects', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(input),
    });

    const data = await res.json();
    if (!res.ok) throw new Error(data?.error || 'Failed to create project');

    if (data?.devBypass) {
      setMsg('Development billing bypass is active — this local test will not use your real upload/minute allowance.');
    }

    return data.project as ProjectCreatedPayload;
  }

  async function onAnalyzeLink(e: React.FormEvent) {
    e.preventDefault();
    if (!sourceUrl.trim()) return;

    try {
      setLoading(true);
      setMsg('Creating project from link...');
      const project = await createProject({
        title: makeProjectTitle(),
        source_type: 'youtube',
        source_url: sourceUrl.trim(),
      });

      await fetch(`/api/projects/${project.id}/start`, { method: 'POST' }).catch(() => null);

      if (onProjectCreated) {
        onProjectCreated(project);
      } else {
        window.location.href = `/dashboard`;
      }
    } catch (error) {
      const text = error instanceof Error ? error.message : 'Could not analyze link';
      setMsg(text);
    } finally {
      setLoading(false);
    }
  }

  async function uploadFile(selectedFile: File) {
    try {
      setLoading(true);
      setUploadProgress(0);
      setMsg('Creating upload project...');

      const cleanedTitle = selectedFile.name.replace(/\.[^/.]+$/, '');
      const project = await createProject({
        title: cleanedTitle || makeProjectTitle(),
        source_type: 'upload',
      });

      setMsg('Preparing direct upload...');
      const prep = await fetch('/api/ingest/upload', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          project_id: project.id,
          filename: selectedFile.name,
          contentType: selectedFile.type || 'application/octet-stream',
          size: selectedFile.size,
        }),
      });
      const prepData = await prep.json();
      if (!prep.ok) {
        throw new Error(prepData?.error || 'Could not prepare upload');
      }

      setMsg('Uploading file directly to storage...');
      const uploadRes = await fetch(prepData.uploadUrl, {
        method: prepData.method || 'PUT',
        headers: prepData.headers || {
          'content-type': selectedFile.type || 'application/octet-stream',
        },
        body: selectedFile,
      });

      if (!uploadRes.ok) {
        const errText = await uploadRes.text().catch(() => 'Upload failed');
        throw new Error(errText || 'Upload failed');
      }

      setUploadProgress(100);
      setMsg('Upload complete. Starting processing...');
      await fetch(`/api/projects/${project.id}/start`, { method: 'POST' }).catch(() => null);

      if (onProjectCreated) {
        onProjectCreated(project);
      } else {
        window.location.href = `/dashboard`;
      }
    } catch (error) {
      const text = error instanceof Error ? error.message : 'Could not upload file';
      setMsg(text);
    } finally {
      setLoading(false);
    }
  }

  async function onUploadFileSelect(e: React.ChangeEvent<HTMLInputElement>) {
    const selected = e.target.files?.[0] ?? null;
    if (!selected) return;
    await uploadFile(selected);
    e.target.value = '';
  }

  if (compact) {
    return (
      <div className="hidden flex-col items-center md:flex">
        <div className="flex w-[520px] items-center gap-2 rounded-full border border-white/15 bg-white/[0.04] px-2 py-1.5">
          <form onSubmit={onAnalyzeLink} className="flex min-w-0 flex-1 items-center gap-2">
            <input
              type="url"
              name="sourceUrl"
              placeholder="Drop a video link"
              value={sourceUrl}
              onChange={(e) => setSourceUrl(e.target.value)}
              className="h-8 min-w-0 flex-1 bg-transparent px-3 text-sm text-white placeholder:text-white/35 outline-none"
            />
            <button
              type="submit"
              disabled={loading}
              className="rounded-full bg-white px-3 py-1.5 text-xs font-semibold text-black transition hover:bg-white/90 disabled:cursor-not-allowed disabled:opacity-60"
            >
              {loading ? '...' : 'Get Clips'}
            </button>
          </form>

          <span className="px-1 text-[11px] uppercase tracking-[0.14em] text-white/35">or</span>
          <label className="cursor-pointer rounded-full border border-white/15 px-3 py-1.5 text-xs font-semibold text-white/85 transition hover:border-white/30 hover:bg-white/[0.05]">
            Upload file
            <input
              type="file"
              accept="video/*,audio/*"
              onChange={onUploadFileSelect}
              className="hidden"
              disabled={loading}
            />
          </label>
        </div>

        {loading ? (
          <div className="mt-3 w-full max-w-[520px]">
            <div className="h-2 overflow-hidden rounded-full bg-white/10">
              <div
                className="h-full rounded-full bg-[linear-gradient(90deg,#8B7CFF,#FF7BD8,#FFB347)] transition-all duration-300"
                style={{ width: `${Math.max(uploadProgress, msg.includes('Uploading') ? 65 : msg.includes('Preparing') ? 20 : msg.includes('Starting') ? 90 : 8)}%` }}
              />
            </div>
          </div>
        ) : null}
        {msg ? <p className="mt-2 text-xs text-white/60">{msg}</p> : null}
      </div>
    );
  }

  return (
    <div className="w-full rounded-2xl border border-white/15 bg-white/5 p-4 md:p-5">
      <div className="flex w-full flex-col gap-2 rounded-2xl border border-white/15 bg-black/35 p-2 lg:flex-row lg:items-center">
        <form onSubmit={onAnalyzeLink} className="flex min-w-0 flex-1 items-center gap-2">
          <input
            type="url"
            name="sourceUrl"
            placeholder="https://youtube.com/watch?v=..."
            value={sourceUrl}
            onChange={(e) => setSourceUrl(e.target.value)}
            className="h-11 min-w-0 flex-1 rounded-xl border border-white/10 bg-transparent px-4 text-sm text-white placeholder:text-white/40 outline-none ring-0 focus:border-white/35"
          />
          <button
            type="submit"
            disabled={loading || !sourceUrl.trim()}
            className="h-11 shrink-0 rounded-xl bg-white px-5 text-sm font-semibold text-black transition hover:bg-white/90 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {loading ? 'Working...' : 'Get Clips'}
          </button>
        </form>

        <div className="flex items-center gap-2 lg:shrink-0">
          <span className="shrink-0 px-1 text-xs uppercase tracking-[0.16em] text-white/45">or</span>
          <label className="grid h-11 flex-1 cursor-pointer place-items-center rounded-xl border border-white/20 px-5 text-sm font-semibold text-white transition duration-200 hover:border-white/35 hover:bg-white/10 lg:flex-none">
            Upload file
            <input
              type="file"
              accept="video/*,audio/*"
              onChange={onUploadFileSelect}
              className="hidden"
              disabled={loading}
            />
          </label>
        </div>
      </div>

      {loading ? (
        <div className="mt-3 w-full">
          <div className="h-2 overflow-hidden rounded-full bg-white/10">
            <div
              className="h-full rounded-full bg-[linear-gradient(90deg,#8B7CFF,#FF7BD8,#FFB347)] transition-all duration-300"
              style={{ width: `${Math.max(uploadProgress, msg.includes('Uploading') ? 65 : msg.includes('Preparing') ? 20 : msg.includes('Starting') ? 90 : 8)}%` }}
            />
          </div>
        </div>
      ) : null}

      {msg ? <p className="mt-3 text-sm text-white/70">{msg}</p> : null}
    </div>
  );
}
