'use client';

import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';
import { AD_STUDIO_MAX_UPLOAD_BYTES, AD_STUDIO_UPLOAD_ACCEPT, isAllowedAdStudioUpload } from '@/lib/ad-studio-upload';

const REELS = [
  ['creator', 'Creator Will'],
  ['mrbeast', 'MrBeast'],
  ['companies', 'Companies'],
  ['intermediate', 'Intermediate'],
  ['capacity', 'Capacity'],
  ['audience', 'Audience'],
] as const;

const CONCEPTS = {
  problem: {
    label: 'Problem / solution',
    hook: 'STOP EDITING CLIPS MANUALLY',
    support: 'Turn one long video into ready-to-post reels with AI.',
    voiceover: 'I used to spend hours finding clips and editing captions. Now I paste one link into AnimaCut and it creates the reels for me.',
  },
  demo: {
    label: 'Live product demo',
    hook: '1 VIDEO → 10 SHORTS',
    support: 'Paste a link. Let AnimaCut find the best moments.',
    voiceover: 'Watch me turn one long video into short-form content. I paste the link, AnimaCut finds the strongest moments, and the reels are ready to edit and download.',
  },
  beforeAfter: {
    label: 'Before / after',
    hook: 'RAW VIDEO → VIRAL-READY REEL',
    support: 'Automatic reframing, captions, hooks, and scoring.',
    voiceover: 'This is the raw video, and this is what AnimaCut made from it. It reframed the speaker, added captions, and found the strongest hook automatically.',
  },
} as const;

type ConceptKey = keyof typeof CONCEPTS;
type Palette = 'pink' | 'yellow' | 'green' | 'purple';

export function AdStudio() {
  const [concept, setConcept] = useState<ConceptKey>('problem');
  const [reel, setReel] = useState<(typeof REELS)[number][0]>('creator');
  const [file, setFile] = useState<File | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [hook, setHook] = useState<string>(CONCEPTS.problem.hook);
  const [support, setSupport] = useState<string>(CONCEPTS.problem.support);
  const [voiceover, setVoiceover] = useState<string>(CONCEPTS.problem.voiceover);
  const [cta, setCta] = useState('TRY ANIMACUT');
  const [duration, setDuration] = useState('15');
  const [palette, setPalette] = useState<Palette>('pink');
  const [campaign, setCampaign] = useState('ugc-test-01');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!file) {
      setPreviewUrl(null);
      return;
    }
    const url = URL.createObjectURL(file);
    setPreviewUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [file]);

  const sourceUrl = previewUrl || `/hero-reels/${reel}.mp4`;
  const accent = useMemo(() => ({
    pink: '#ff4fc8', yellow: '#ffff00', green: '#21f45a', purple: '#a855f7',
  })[palette], [palette]);

  function chooseConcept(next: ConceptKey) {
    setConcept(next);
    setHook(CONCEPTS[next].hook);
    setSupport(CONCEPTS[next].support);
    setVoiceover(CONCEPTS[next].voiceover);
  }

  function chooseFile(nextFile: File | null) {
    setError('');
    if (!nextFile) {
      setFile(null);
      return;
    }
    if (!isAllowedAdStudioUpload(nextFile)) {
      setFile(null);
      setError('Choose an OBS video in MP4, MOV, WebM, MKV, or FLV format.');
      return;
    }
    if (nextFile.size > AD_STUDIO_MAX_UPLOAD_BYTES) {
      setFile(null);
      setError('Uploaded footage must be under 300 MB.');
      return;
    }
    setFile(nextFile);
  }

  async function renderAd() {
    setBusy(true);
    setError('');
    try {
      const body = new FormData();
      body.set('concept', concept);
      body.set('reel', reel);
      body.set('hook', hook);
      body.set('support', support);
      body.set('cta', cta);
      body.set('duration', duration);
      body.set('palette', palette);
      body.set('campaign', campaign);
      if (file) body.set('file', file);
      const response = await fetch('/api/admin/ad-studio/render', { method: 'POST', body });
      if (!response.ok) {
        const payload = await response.json().catch(() => null);
        throw new Error(payload?.error || 'Could not render the ad');
      }
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = `animacut-${campaign || 'ad'}.mp4`;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      setTimeout(() => URL.revokeObjectURL(url), 30_000);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Could not render the ad');
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="mx-auto w-full max-w-7xl px-4 py-8 sm:px-6 lg:py-12">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <Link href="/dashboard" className="text-sm text-white/55 transition hover:text-white">← Dashboard</Link>
          <h1 className="mt-4 text-3xl font-black sm:text-4xl">AnimaCut Ad Studio</h1>
          <p className="mt-2 max-w-2xl text-sm leading-6 text-white/60">Build testable 9:16 creative from real AnimaCut footage. Rendering creates a campaign-ready MP4; publishing stays manual.</p>
        </div>
        <span className="rounded-full border border-[#21f45a]/25 bg-[#21f45a]/10 px-3 py-1.5 text-xs font-bold text-[#7dff9c]">Admin only</span>
      </div>

      <div className="mt-8 grid gap-7 lg:grid-cols-[minmax(0,1fr)_390px]">
        <section className="rounded-3xl border border-white/10 bg-white/[0.035] p-5 sm:p-7">
          <div className="grid gap-6 sm:grid-cols-2">
            <Field label="Ad concept">
              <select value={concept} onChange={(event) => chooseConcept(event.target.value as ConceptKey)} className={controlClass}>
                {Object.entries(CONCEPTS).map(([key, value]) => <option key={key} value={key}>{value.label}</option>)}
              </select>
            </Field>
            <Field label="Campaign ID">
              <input value={campaign} onChange={(event) => setCampaign(event.target.value)} className={controlClass} maxLength={48} />
            </Field>
            <Field label="Footage">
              <select value={reel} disabled={Boolean(file)} onChange={(event) => setReel(event.target.value as typeof reel)} className={controlClass}>
                {REELS.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
              </select>
            </Field>
            <Field label="Or upload footage">
              <input type="file" accept={AD_STUDIO_UPLOAD_ACCEPT} onChange={(event) => chooseFile(event.target.files?.[0] || null)} className="block w-full rounded-xl border border-white/10 bg-black/25 px-3 py-2.5 text-sm text-white/65 file:mr-3 file:rounded-lg file:border-0 file:bg-white file:px-3 file:py-1.5 file:text-xs file:font-bold file:text-black" />
              <p className="mt-2 text-xs leading-5 text-white/40">OBS MP4, MOV, WebM, MKV, or FLV · maximum 300 MB</p>
              {file ? <button type="button" onClick={() => setFile(null)} className="mt-2 text-xs text-white/50 underline">Use a permanent reel instead</button> : null}
            </Field>
          </div>

          <div className="mt-6 space-y-5">
            <Field label="Opening hook">
              <input value={hook} onChange={(event) => setHook(event.target.value)} className={controlClass} maxLength={80} />
            </Field>
            <Field label="Supporting line">
              <textarea value={support} onChange={(event) => setSupport(event.target.value)} className={`${controlClass} min-h-20 resize-y`} maxLength={160} />
            </Field>
            <Field label="UGC voiceover script (production note)">
              <textarea value={voiceover} onChange={(event) => setVoiceover(event.target.value)} className={`${controlClass} min-h-28 resize-y`} />
              <button type="button" onClick={() => navigator.clipboard.writeText(voiceover)} className="mt-2 text-xs font-semibold text-[#ff8ddb] hover:text-white">Copy script</button>
            </Field>
            <div className="grid gap-5 sm:grid-cols-3">
              <Field label="CTA"><input value={cta} onChange={(event) => setCta(event.target.value)} className={controlClass} maxLength={40} /></Field>
              <Field label="Length">
                <select value={duration} onChange={(event) => setDuration(event.target.value)} className={controlClass}><option value="15">15 seconds</option><option value="20">20 seconds</option><option value="25">25 seconds</option></select>
              </Field>
              <Field label="Accent">
                <select value={palette} onChange={(event) => setPalette(event.target.value as Palette)} className={controlClass}><option value="pink">AnimaCut pink</option><option value="yellow">Bright yellow</option><option value="green">Green</option><option value="purple">Purple</option></select>
              </Field>
            </div>
          </div>

          {error ? <p className="mt-5 rounded-xl border border-red-400/25 bg-red-400/10 px-4 py-3 text-sm text-red-100">{error}</p> : null}
          <button type="button" disabled={busy || !hook.trim() || !cta.trim()} onClick={renderAd} className="mt-7 w-full rounded-2xl bg-white px-5 py-3.5 text-sm font-black text-black transition hover:-translate-y-0.5 hover:bg-white/90 disabled:cursor-not-allowed disabled:opacity-50">
            {busy ? 'Rendering MP4…' : 'Render and download MP4'}
          </button>
        </section>

        <aside className="lg:sticky lg:top-6 lg:self-start">
          <p className="mb-3 text-xs font-bold uppercase tracking-[0.18em] text-white/45">Creative preview</p>
          <div className="relative mx-auto aspect-[9/16] w-full max-w-[360px] overflow-hidden rounded-[32px] border border-white/15 bg-black shadow-2xl">
            <video key={sourceUrl} src={sourceUrl} autoPlay muted loop playsInline className="h-full w-full object-cover" />
            <div className="absolute inset-x-0 top-[8%] px-5 text-center">
              <p className="text-[clamp(22px,3vw,34px)] font-black uppercase leading-[0.95] text-white drop-shadow-[0_3px_8px_rgba(0,0,0,0.9)]">{hook}</p>
              <span className="mx-auto mt-3 block h-1.5 w-16 rounded-full" style={{ backgroundColor: accent }} />
            </div>
            <div className="absolute inset-x-0 bottom-[16%] px-5 text-center">
              <p className="rounded-2xl bg-black/65 px-4 py-3 text-sm font-bold leading-5 text-white backdrop-blur">{support}</p>
            </div>
            <div className="absolute inset-x-0 bottom-[5%] flex justify-center px-5"><span className="rounded-full px-5 py-2 text-sm font-black text-black" style={{ backgroundColor: accent }}>{cta}</span></div>
          </div>
          <p className="mx-auto mt-4 max-w-[360px] text-xs leading-5 text-white/45">The MP4 repeats the chosen footage smoothly to fill the selected duration. Add recorded or generated voiceover in the next production pass.</p>
        </aside>
      </div>
    </main>
  );
}

const controlClass = 'w-full rounded-xl border border-white/10 bg-black/30 px-3.5 py-3 text-sm text-white outline-none transition placeholder:text-white/25 focus:border-[#ff63c3]/55';

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return <label className="block"><span className="mb-2 block text-xs font-bold uppercase tracking-[0.12em] text-white/50">{label}</span>{children}</label>;
}
