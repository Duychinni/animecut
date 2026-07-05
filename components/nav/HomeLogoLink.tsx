'use client';

import Image from 'next/image';

export function HomeLogoLink() {
  return (
    <button
      type="button"
      onClick={() => window.location.assign('/')}
      className="cursor-pointer flex items-center"
      aria-label="Go to AnimaCut home"
    >
      <Image
        src="/brand/animacut-wordmark.png"
        alt="AnimaCut"
        width={180}
        height={48}
        className="h-9 w-auto"
        priority
      />
    </button>
  );
}
