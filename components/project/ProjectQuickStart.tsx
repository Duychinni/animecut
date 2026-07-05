'use client';

import { useState } from 'react';

export function ProjectQuickStart() {
  const [sourceUrl, setSourceUrl] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [msg, setMsg] = useState('');
  const [loading, setLoading] = useState(false);

  async function createProject(input: { title: string; source_type: 'youtube' | 'upload'; source_url?: string }) {
    const res = await fetch('/api/projects', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(input),
    });

    const data = await res.json();
    if (!res.ok) throw new Error(data?.error || 'Failed to create project');
    return data.project.id as string;
  }

  async function onAnalyzeLink(e: React.FormEvent) {
    e.preventDefault();
    if (!sourceUrl.trim()) {
      setMsg('Paste a YouTube link first, or use Upload files.');
      return;
    }

    try {
      setLoading(true);
      setMsg('Creating project from link...');
      const projectId = await createProject({
        title: 'MAIN PROJECTS',
        source_type: 'youtube',
        source_url: sourceUrl.trim(),
      });

      window.location.href = `/dashboard/projects/${projectId}?autorun=1`;
    } catch (error: unknown) {
      const text = error instanceof Error ? error.message : 'Could not analyze link';
      setMsg(`Error: ${text}`);
    } finally {
      setLoading(false);
    }
  }

  async function uploadFile(selectedFile: File) {
    try {
      setLoading(true);
      setMsg('Creating upload project...');
      const projectId = await createProject({
        title: 'MAIN PROJECTS',
        source_type: 'upload',
      });

      setMsg('Uploading file...');
      const form = new FormData();
      form.append('project_id', projectId);
      form.append('file', selectedFile);

      const up = await fetch('/api/ingest/upload', { method: 'POST', body: form });
      const upData = await up.json();
      if (!up.ok) throw new Error(upData?.error || 'Upload failed');

      window.location.href = `/dashboard/projects/${projectId}?autorun=1`;
    } catch (error: unknown) {
      const text = error instanceof Error ? error.message : 'Could not upload file';
      setMsg(`Error: ${text}`);
    } finally {
      setLoading(false);
    }
  }

  async function onUploadFileSelect(e: React.ChangeEvent<HTMLInputElement>) {
    const selected = e.target.files?.[0] ?? null;
    setFile(selected);
    if (!selected) return;
    await uploadFile(selected);
    e.target.value = '';
  }

  return (
    <div className="w-full rounded-2xl border border-white/15 bg-white/5 p-4 md:p-5">
      <div className="flex w-full items-center gap-2 rounded-2xl border border-white/15 bg-black/35 p-2">
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
            disabled={loading}
            className="h-11 shrink-0 rounded-xl bg-white px-5 text-sm font-semibold text-black transition hover:bg-white/90 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {loading ? 'Working...' : 'Get Clips'}
          </button>
        </form>

        <span className="shrink-0 text-xs uppercase tracking-[0.16em] text-white/45">or</span>

        <label className="grid h-11 shrink-0 cursor-pointer place-items-center rounded-xl border border-white/30 px-5 text-sm font-semibold hover:bg-white/10">
          Upload files
          <input
            type="file"
            accept="video/*,audio/*"
            onChange={onUploadFileSelect}
            className="hidden"
            disabled={loading}
          />
        </label>
      </div>

      {file ? <p className="mt-2 text-left text-xs text-white/50">Selected: {file.name}</p> : null}
      {msg ? <p className="mt-3 text-left text-sm text-white/70">{msg}</p> : null}
    </div>
  );
}
