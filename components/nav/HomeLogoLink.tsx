'use client';

import Image from 'next/image';

export function HomeLogoLink() {
  return (
    <button
      type="button"
      onClick={() => window.location.assign('/')}
      className="cursor-pointer flex w-[220px] items-center justify-start overflow-visible"
      aria-label="Go to AnimaCut home"
    >
      <Image
        src="/brand/animacut-wordmark.png"
        alt="AnimaCut"
        width={420}
        height={120}
        className="h-[78px] w-auto max-w-none object-contain"
        priority
      />
    </button>
  );
}
