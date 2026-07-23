'use client';

import { useEffect, useState } from 'react';
import type { AdAsset } from '@/lib/ad-studio-assets';
import type { AdStoryboard, AdStoryboardScene } from '@/lib/ad-storyboard';

type Props = { selectedAsset: AdAsset | null };

export function AdStoryboardBuilder({ selectedAsset }: Props) {
  const [storyboard, setStoryboard] = useState<AdStoryboard | null>(null);
  const [audience, setAudience] = useState('Podcasters and YouTube creators');
  const [offer, setOffer] = useState('Turn one long video into ready-to-post reels');
  const [duration, setDuration] = useState('20');
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState('');
  const [error, setError] = useState('');

  useEffect(() => {
    setStoryboard(null);
    setError('');
    if (!selectedAsset) return;
    void fetch(`/api/admin/ad-studio/storyboard?assetPath=${encodeURIComponent(selectedAsset.path)}`, { cache: 'no-store' })
      .then(async (response) => {
        const payload = await response.json();
        if (!response.ok) throw new Error(payload.error || 'Could not load storyboard');
        if (payload.storyboard) setStoryboard(payload.storyboard);
      })
      .catch((reason) => setError(reason instanceof Error ? reason.message : 'Could not load storyboard'));
  }, [selectedAsset]);

  async function analyze() {
    if (!selectedAsset) return;
    setBusy(true);
    setError('');
    setStatus('Sampling the full recording and identifying the strongest workflow moments…');
    try {
      const response = await fetch('/api/admin/ad-studio/storyboard', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          assetPath: selectedAsset.path,
          assetName: selectedAsset.name,
          audience,
          offer,
          targetDuration: Number(duration),
        }),
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || 'Could not analyze the recording');
      setStoryboard(payload.storyboard);
      setStatus('Storyboard generated and saved.');
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Could not analyze the recording');
      setStatus('');
    } finally {
      setBusy(false);
    }
  }

  function updateScene(index: number, update: Partial<AdStoryboardScene>) {
    if (!storyboard) return;
    const scenes = storyboard.scenes.map((scene, sceneIndex) => sceneIndex === index ? { ...scene, ...update } : scene);
    setStoryboard({ ...storyboard, scenes, totalDuration: Number(scenes.reduce((sum, scene) => sum + Number(scene.adDuration || 0), 0).toFixed(2)) });
  }

  async function save() {
    if (!storyboard) return;
    setBusy(true);
    setError('');
    try {
      const response = await fetch('/api/admin/ad-studio/storyboard', {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ storyboard }),
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || 'Could not save storyboard');
      setStoryboard(payload.storyboard);
      setStatus('Storyboard changes saved.');
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Could not save storyboard');
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="mt-8 rounded-3xl border border-[#a855f7]/25 bg-[#a855f7]/[0.055] p-5 sm:p-7">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <p className="text-xs font-black uppercase tracking-[0.18em] text-[#c995ff]">Step 2</p>
          <h2 className="mt-2 text-xl font-black">AI footage analysis & storyboard</h2>
          <p className="mt-1 max-w-2xl text-sm leading-6 text-white/55">Select one full product-demo recording above. AnimaCut samples the entire video, finds the key workflow moments, and drafts an editable multi-scene UGC ad.</p>
        </div>
        <span className="rounded-full border border-white/10 bg-black/20 px-3 py-1.5 text-xs font-bold text-white/55">{selectedAsset ? selectedAsset.name : 'No recording selected'}</span>
      </div>

      <div className="mt-6 grid gap-4 md:grid-cols-[1fr_1fr_150px]">
        <label className="block"><span className={labelClass}>Target audience</span><input value={audience} onChange={(event) => setAudience(event.target.value)} className={controlClass} /></label>
        <label className="block"><span className={labelClass}>Offer / outcome</span><input value={offer} onChange={(event) => setOffer(event.target.value)} className={controlClass} /></label>
        <label className="block"><span className={labelClass}>Ad length</span><select value={duration} onChange={(event) => setDuration(event.target.value)} className={controlClass}><option value="15">15 seconds</option><option value="20">20 seconds</option><option value="25">25 seconds</option><option value="30">30 seconds</option></select></label>
      </div>

      <button type="button" disabled={!selectedAsset || busy} onClick={analyze} className="mt-5 rounded-xl bg-[#a855f7] px-5 py-3 text-sm font-black text-white transition hover:bg-[#b96cff] disabled:cursor-not-allowed disabled:opacity-45">
        {busy ? 'Analyzing full recording…' : storyboard ? 'Analyze again' : 'Analyze full video demo'}
      </button>
      {!selectedAsset ? <p className="mt-3 text-xs text-white/45">Click “Select for ad” on Full video demo in the library above.</p> : null}
      {status ? <p className="mt-4 text-sm font-semibold text-[#d8b4fe]">{status}</p> : null}
      {error ? <p className="mt-4 rounded-xl border border-red-400/25 bg-red-400/10 px-4 py-3 text-sm text-red-100">{error}</p> : null}

      {storyboard ? (
        <div className="mt-7">
          <div className="grid gap-4 sm:grid-cols-2">
            <label><span className={labelClass}>Creative angle</span><input value={storyboard.angle} onChange={(event) => setStoryboard({ ...storyboard, angle: event.target.value })} className={controlClass} /></label>
            <label><span className={labelClass}>Opening hook</span><input value={storyboard.hook} onChange={(event) => setStoryboard({ ...storyboard, hook: event.target.value })} className={controlClass} /></label>
          </div>
          <label className="mt-4 block"><span className={labelClass}>Full voiceover draft</span><textarea value={storyboard.voiceoverScript} onChange={(event) => setStoryboard({ ...storyboard, voiceoverScript: event.target.value })} className={`${controlClass} min-h-24 resize-y`} /></label>
          <div className="mt-5 flex items-center justify-between gap-4">
            <h3 className="font-black">Scene plan</h3>
            <p className="text-xs font-bold text-white/45">{storyboard.scenes.length} scenes · {storyboard.totalDuration.toFixed(1)}s</p>
          </div>
          <div className="mt-3 space-y-3">
            {storyboard.scenes.map((scene, index) => (
              <article key={scene.id} className="rounded-2xl border border-white/10 bg-black/20 p-4">
                <div className="flex flex-wrap items-center gap-3">
                  <span className="flex h-7 w-7 items-center justify-center rounded-full bg-white text-xs font-black text-black">{index + 1}</span>
                  <input value={scene.purpose} onChange={(event) => updateScene(index, { purpose: event.target.value })} className={`${controlClass} min-w-[180px] flex-1 py-2`} />
                  <label className="text-xs text-white/45">Source <input type="number" step="0.1" min="0" value={scene.sourceStart} onChange={(event) => updateScene(index, { sourceStart: Number(event.target.value) })} className={timeClass} />–<input type="number" step="0.1" min="0" value={scene.sourceEnd} onChange={(event) => updateScene(index, { sourceEnd: Number(event.target.value) })} className={timeClass} />s</label>
                  <label className="text-xs text-white/45">Ad <input type="number" step="0.5" min="1" max="8" value={scene.adDuration} onChange={(event) => updateScene(index, { adDuration: Number(event.target.value) })} className={timeClass} />s</label>
                </div>
                <div className="mt-3 grid gap-3 md:grid-cols-3">
                  <label><span className={labelClass}>What viewers see</span><textarea value={scene.visual} onChange={(event) => updateScene(index, { visual: event.target.value })} className={`${controlClass} min-h-20 resize-y`} /></label>
                  <label><span className={labelClass}>On-screen text</span><textarea value={scene.onScreenText} onChange={(event) => updateScene(index, { onScreenText: event.target.value })} className={`${controlClass} min-h-20 resize-y`} /></label>
                  <label><span className={labelClass}>Voiceover</span><textarea value={scene.voiceover} onChange={(event) => updateScene(index, { voiceover: event.target.value })} className={`${controlClass} min-h-20 resize-y`} /></label>
                </div>
              </article>
            ))}
          </div>
          <button type="button" disabled={busy} onClick={save} className="mt-5 rounded-xl border border-white/20 bg-white px-5 py-3 text-sm font-black text-black hover:bg-white/90 disabled:opacity-50">Save storyboard</button>
          <p className="mt-3 text-xs leading-5 text-white/40">This saves the edit plan. Step 3 will use these exact source timestamps to cut and assemble the finished UGC ad.</p>
        </div>
      ) : null}
    </section>
  );
}

const labelClass = 'mb-2 block text-xs font-bold uppercase tracking-[0.12em] text-white/45';
const controlClass = 'w-full rounded-xl border border-white/10 bg-black/30 px-3.5 py-3 text-sm text-white outline-none focus:border-[#a855f7]/70';
const timeClass = 'mx-1 w-20 rounded-lg border border-white/10 bg-black/35 px-2 py-1.5 text-sm text-white outline-none';

