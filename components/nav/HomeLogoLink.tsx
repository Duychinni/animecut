'use client';

export function HomeLogoLink() {
  return (
    <button
      type="button"
      onClick={() => window.location.assign('/')}
      className="cursor-pointer flex items-center gap-2 font-semibold tracking-tight text-white"
      aria-label="Go to ClipSpark home"
    >
      <span className="grid h-7 w-7 place-items-center rounded-full border border-white/15 bg-white/[0.08] text-xs font-bold text-white">C</span>
      ClipSpark
    </button>
  );
}
