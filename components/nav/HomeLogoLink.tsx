'use client';

export function HomeLogoLink() {
  return (
    <button
      type="button"
      onClick={() => window.location.assign('/')}
      className="cursor-pointer flex items-center gap-2 font-semibold tracking-tight"
      aria-label="Go to ClipSpark home"
    >
      <span className="grid h-7 w-7 place-items-center rounded-full bg-white text-xs font-bold text-black">C</span>
      ClipSpark
    </button>
  );
}
