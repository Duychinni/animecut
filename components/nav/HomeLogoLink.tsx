'use client';

import Image from 'next/image';

export function HomeLogoLink() {
  return (
    <button
      type="button"
      onClick={() => window.location.assign('/')}
      className="cursor-pointer flex items-center gap-3 font-semibold tracking-tight text-white"
      aria-label="Go to AnimaCut home"
    >
      <Image src="/brand/animacut-logo.png" alt="AnimaCut" width={132} height={34} className="h-8 w-auto" priority />
    </button>
  );
}
