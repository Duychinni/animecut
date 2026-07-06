'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';

async function readJsonSafe(res: Response) {
  const text = await res.text();

  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    return {
      error: text.trim().startsWith('<')
        ? `Server returned HTML instead of JSON (status ${res.status})`
        : text || `Request failed with status ${res.status}`,
    };
  }
}

export function CandidatePreviewButton({ projectId, candidateId }: { projectId: string; candidateId: string }) {
  const router = useRouter();
  const [loading, setLoading] = useState(false);
  const [msg, setMsg] = useState('');
  const [captionsEnabled, setCaptionsEnabled] = useState(true);
  const [captionTemplate, setCaptionTemplate] = useState<'clean' | 'bold' | 'viral' | 'karaoke' | 'cinematic' | 'rage' | 'minimal' | 'capcut'>('capcut');
  const [captionFont, setCaptionFont] = useState<'arial' | 'montserrat' | 'impact' | 'bangers' | 'anton' | 'bebas' | 'poppins'>('montserrat');
  const [motionTracking, setMotionTracking] = useState(true);
  const [autoReframe, setAutoReframe] = useState(true);
  const [reframeMode, setReframeMode] = useState<'off' | 'basic' | 'smart'>('basic');

  async function previewCandidate() {
    setLoading(true);
    setMsg('Queueing preview...');

    const q = await fetch('/api/clips/export', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        project_id: projectId,
        candidate_ids: [candidateId],
        captions_enabled: captionsEnabled,
        caption_template: captionTemplate,
        caption_font: captionFont,
        motion_tracking: motionTracking,
        auto_reframe: autoReframe,
        reframe_mode: reframeMode,
      }),
    });
    const qData = await readJsonSafe(q);

    if (!q.ok) {
      setMsg(`Queue failed: ${String(qData.error || 'unknown')}`);
      setLoading(false);
      return;
    }

    setMsg('Rendering...');
    const p = await fetch('/api/jobs/process', { method: 'POST' });
    const pData = await readJsonSafe(p);

    if (!p.ok) {
      setMsg(`Render failed: ${String(pData.error || 'unknown')}`);
      setLoading(false);
      return;
    }

    const processed = Number(pData.processed ?? 0);
    if (processed < 1) {
      setMsg('No queued render was processed. Check Recent exports status (queued/processing/error).');
      router.refresh();
      setLoading(false);
      return;
    }

    setMsg('Render finished. Check Recent exports below.');
    router.refresh();
    setLoading(false);
  }

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2 text-xs text-white/75">
        <label className="flex items-center gap-1.5">
          <input
            type="checkbox"
            checked={captionsEnabled}
            onChange={(e) => setCaptionsEnabled(e.target.checked)}
            className="h-3.5 w-3.5"
          />
          Captions
        </label>
        <select
          disabled={!captionsEnabled || loading}
          value={captionTemplate}
          onChange={(e) =>
            setCaptionTemplate(e.target.value as 'clean' | 'bold' | 'viral' | 'karaoke' | 'cinematic' | 'rage' | 'minimal' | 'capcut')
          }
          className="rounded border border-white/20 bg-black/40 px-2 py-1 text-xs text-white disabled:opacity-50"
        >
          <option value="capcut">CapCut Bold (White/Yellow)</option>
          <option value="clean">Clean</option>
          <option value="bold">Bold</option>
          <option value="viral">Viral</option>
          <option value="karaoke">Karaoke Pop</option>
          <option value="cinematic">Cinematic</option>
          <option value="rage">Rage</option>
          <option value="minimal">Minimal</option>
        </select>
        <select
          disabled={!captionsEnabled || loading}
          value={captionFont}
          onChange={(e) => setCaptionFont(e.target.value as 'arial' | 'montserrat' | 'impact' | 'bangers' | 'anton' | 'bebas' | 'poppins')}
          className="rounded border border-white/20 bg-black/40 px-2 py-1 text-xs text-white disabled:opacity-50"
        >
          <option value="montserrat">Montserrat</option>
          <option value="anton">Anton</option>
          <option value="bebas">Bebas Neue</option>
          <option value="poppins">Poppins</option>
          <option value="impact">Impact</option>
          <option value="bangers">Bangers</option>
          <option value="arial">Arial</option>
        </select>
        <label className="flex items-center gap-1.5">
          <input
            type="checkbox"
            checked={motionTracking}
            onChange={(e) => setMotionTracking(e.target.checked)}
            className="h-3.5 w-3.5"
          />
          Motion track
        </label>
        <label className="flex items-center gap-1.5">
          <input
            type="checkbox"
            checked={autoReframe}
            onChange={(e) => setAutoReframe(e.target.checked)}
            className="h-3.5 w-3.5"
          />
          Auto reframe
        </label>
        <select
          disabled={!autoReframe || loading}
          value={reframeMode}
          onChange={(e) => setReframeMode(e.target.value as 'off' | 'basic' | 'smart')}
          className="rounded border border-white/20 bg-black/40 px-2 py-1 text-xs text-white disabled:opacity-50"
        >
          <option value="basic">Reframe: Basic</option>
          <option value="smart">Reframe: Smart</option>
          <option value="off">Reframe: Off</option>
        </select>
      </div>

      <button
        type="button"
        disabled={loading}
        onClick={previewCandidate}
        className="rounded-md border border-white/25 px-3 py-1.5 text-xs font-semibold text-white transition hover:bg-white/10 disabled:cursor-not-allowed disabled:opacity-60"
      >
        {loading ? 'Rendering...' : 'Preview this clip'}
      </button>
      {msg ? <p className="text-xs text-white/60">{msg}</p> : null}
    </div>
  );
}
