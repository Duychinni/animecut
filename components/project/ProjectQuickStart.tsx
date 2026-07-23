'use client';

import { useState } from 'react';
import { getDirectUploadError, uploadFileMultipartToR2 } from '@/lib/browser-upload';
import { readJsonSafe } from '@/lib/safe-json';
import { isSupportedYouTubeVideoUrl, YOUTUBE_LINK_ERROR } from '@/lib/youtube-url';
import { captureEvent } from '@/lib/analytics';
import { isUploadLimitError, sourceUploadSizeError } from '@/lib/upload-limits';

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

function readLocalVideoDuration(file: File) {
  return new Promise<number>((resolve, reject) => {
    const video = document.createElement('video');
    const objectUrl = URL.createObjectURL(file);
    let settled = false;

    const finish = (error?: Error, durationSeconds?: number) => {
      if (settled) return;
      settled = true;
      URL.revokeObjectURL(objectUrl);
      video.removeAttribute('src');
      if (error) reject(error);
      else resolve(durationSeconds ?? 0);
    };

    video.preload = 'metadata';
    video.onloadedmetadata = () => {
      if (!Number.isFinite(video.duration) || video.duration <= 0) {
        finish(new Error('Could not determine this video\'s duration.'));
        return;
      }
      finish(undefined, video.duration);
    };
    video.onerror = () => finish(new Error('This file could not be read as a video.'));
    video.src = objectUrl;
  });
}

export function ProjectQuickStart({ compact = false, onProjectCreated }: Props) {
  const [sourceUrl, setSourceUrl] = useState('');
  const [loading, setLoading] = useState(false);
  const [msg, setMsg] = useState('');
  const [uploadProgress, setUploadProgress] = useState(0);

  async function createProject(input: { title: string; source_type: 'youtube' | 'upload'; source_url?: string; source_duration_seconds?: number }) {
    const res = await fetch('/api/projects', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(input),
    });

    const data = await readJsonSafe(res);
    if (!res.ok) throw new Error(String(data?.error || 'Failed to create project'));

    if (data?.devBypass) {
      setMsg('Development billing bypass is active — this local test will not use your real upload/minute allowance.');
    }

    return data.project as ProjectCreatedPayload;
  }

  async function onAnalyzeLink(e: React.FormEvent) {
    e.preventDefault();
    if (!sourceUrl.trim()) {
      setMsg('Paste a YouTube link first, or use Upload file.');
      return;
    }
    if (!isSupportedYouTubeVideoUrl(sourceUrl)) {
      setMsg(YOUTUBE_LINK_ERROR);
      return;
    }

    try {
      captureEvent('upload_started', { source_type: 'youtube' });
      setLoading(true);
      setMsg('Creating project from link...');
      const project = await createProject({
        title: makeProjectTitle(),
        source_type: 'youtube',
        source_url: sourceUrl.trim(),
      });

      await fetch(`/api/projects/${project.id}/start`, { method: 'POST' }).catch(() => null);
      captureEvent('upload_completed', { source_type: 'youtube' });

      if (onProjectCreated) {
        onProjectCreated(project);
      } else {
        window.location.href = `/dashboard`;
      }
    } catch (error) {
      const text = error instanceof Error ? error.message : 'Could not analyze link';
      captureEvent('upload_failed', { source_type: 'youtube', error_type: text.slice(0, 80) });
      setMsg(text);
    } finally {
      setLoading(false);
    }
  }

  async function uploadFile(selectedFile: File) {
    try {
      captureEvent('upload_started', { source_type: 'upload', size_mb: Math.round(selectedFile.size / 1024 / 1024) });
      setLoading(true);
      setUploadProgress(0);
      setMsg('Checking video length...');

      const durationSeconds = await readLocalVideoDuration(selectedFile);
      setMsg('Creating upload project...');

      const cleanedTitle = selectedFile.name.replace(/\.[^/.]+$/, '');
      const project = await createProject({
        title: cleanedTitle || makeProjectTitle(),
        source_type: 'upload',
        source_duration_seconds: durationSeconds,
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
      const prepData = await readJsonSafe(prep);
      if (!prep.ok) {
        throw new Error(String(prepData?.error || 'Could not prepare upload'));
      }

      if (
        prepData.provider === 'r2-multipart' &&
        typeof prepData.uploadId === 'string' &&
        typeof prepData.objectPath === 'string' &&
        typeof prepData.partSize === 'number' &&
        typeof prepData.partUrl === 'string' &&
        typeof prepData.completeUrl === 'string'
      ) {
        setMsg('Uploading file in parts to R2 storage...');
        await uploadFileMultipartToR2(selectedFile, prepData as Parameters<typeof uploadFileMultipartToR2>[1], setUploadProgress);
      } else {
        const uploadUrl = typeof prepData.uploadUrl === 'string' ? prepData.uploadUrl : null;
        const uploadMethod = typeof prepData.method === 'string' ? prepData.method : 'PUT';
        const uploadHeaders = (prepData.headers && typeof prepData.headers === 'object')
          ? (prepData.headers as HeadersInit)
          : { 'content-type': selectedFile.type || 'application/octet-stream' };

        if (!uploadUrl) {
          throw new Error('Upload URL missing');
        }

        setMsg('Uploading file directly to storage...');
        const uploadRes = await fetch(uploadUrl, {
          method: uploadMethod,
          headers: uploadHeaders,
          body: selectedFile,
        });

        if (!uploadRes.ok) {
          throw new Error(await getDirectUploadError(uploadRes));
        }

        setUploadProgress(100);
      }
      setMsg('Upload complete. Starting processing...');
      captureEvent('upload_completed', { source_type: 'upload', duration_seconds: Math.round(durationSeconds) });
      await fetch(`/api/projects/${project.id}/start`, { method: 'POST' }).catch(() => null);

      if (onProjectCreated) {
        onProjectCreated(project);
      } else {
        window.location.href = `/dashboard`;
      }
    } catch (error) {
      const text = error instanceof Error ? error.message : 'Could not upload file';
      captureEvent('upload_failed', { source_type: 'upload', error_type: text.slice(0, 80) });
      setMsg(text);
    } finally {
      setLoading(false);
    }
  }

  async function onUploadFileSelect(e: React.ChangeEvent<HTMLInputElement>) {
    const selected = e.target.files?.[0] ?? null;
    if (!selected) return;
    const sizeError = sourceUploadSizeError(selected.size);
    if (sizeError) {
      setMsg(sizeError);
      e.target.value = '';
      return;
    }
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
              placeholder="Paste a YouTube video link"
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

        <p className="mt-2 max-w-[520px] text-center text-[11px] leading-4 text-white/45">
          By continuing, you confirm you have permission to use this content.
        </p>

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
        {msg ? (
          <p className={`mt-2 text-xs ${isUploadLimitError(msg) ? 'font-semibold text-red-400' : 'text-white/60'}`}>
            {msg}
          </p>
        ) : null}
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

      <p className="mt-3 text-xs leading-5 text-white/50">
        By continuing, you confirm you have permission to use this content.
      </p>

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

      {msg ? (
        <p className={`mt-3 text-sm ${isUploadLimitError(msg) ? 'font-semibold text-red-400' : 'text-white/70'}`}>
          {msg}
        </p>
      ) : null}
    </div>
  );
}
