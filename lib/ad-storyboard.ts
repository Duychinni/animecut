export type AdStoryboardScene = {
  id: string;
  sourceStart: number;
  sourceEnd: number;
  adDuration: number;
  purpose: string;
  visual: string;
  onScreenText: string;
  voiceover: string;
};

export type AdStoryboard = {
  id: string;
  assetPath: string;
  assetName: string;
  angle: string;
  audience: string;
  hook: string;
  voiceoverScript: string;
  totalDuration: number;
  sourceDuration: number;
  scenes: AdStoryboardScene[];
  createdAt: string;
  updatedAt: string;
};

export function normalizeStoryboard(value: unknown, asset: { path: string; name: string }, sourceDuration: number): AdStoryboard {
  const raw = (value && typeof value === 'object' ? value : {}) as Record<string, unknown>;
  const rawScenes = Array.isArray(raw.scenes) ? raw.scenes : [];
  const scenes = rawScenes.slice(0, 8).map((scene, index) => {
    const item = (scene && typeof scene === 'object' ? scene : {}) as Record<string, unknown>;
    const start = Math.max(0, Math.min(sourceDuration, Number(item.sourceStart) || 0));
    const end = Math.max(start + 0.5, Math.min(sourceDuration, Number(item.sourceEnd) || start + 3));
    return {
      id: String(item.id || `scene-${index + 1}`),
      sourceStart: Number(start.toFixed(2)),
      sourceEnd: Number(end.toFixed(2)),
      adDuration: Number(Math.max(1, Math.min(8, Number(item.adDuration) || end - start)).toFixed(2)),
      purpose: String(item.purpose || `Scene ${index + 1}`).slice(0, 80),
      visual: String(item.visual || '').slice(0, 240),
      onScreenText: String(item.onScreenText || '').slice(0, 100),
      voiceover: String(item.voiceover || '').slice(0, 280),
    };
  });
  const now = new Date().toISOString();
  return {
    id: String(raw.id || crypto.randomUUID()),
    assetPath: asset.path,
    assetName: asset.name,
    angle: String(raw.angle || 'Turn one long video into ready-to-post reels').slice(0, 160),
    audience: String(raw.audience || 'Podcasters and YouTube creators').slice(0, 120),
    hook: String(raw.hook || 'I stopped editing clips manually').slice(0, 120),
    voiceoverScript: String(raw.voiceoverScript || scenes.map((scene) => scene.voiceover).filter(Boolean).join(' ')).slice(0, 1600),
    totalDuration: Number(scenes.reduce((total, scene) => total + scene.adDuration, 0).toFixed(2)),
    sourceDuration: Number(sourceDuration.toFixed(2)),
    scenes,
    createdAt: String(raw.createdAt || now),
    updatedAt: now,
  };
}

