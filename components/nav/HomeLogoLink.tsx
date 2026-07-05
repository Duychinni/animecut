'use client';

import Image from 'next/image';

export function HomeLogoLink() {
  return (
    <button
      type="button"
      onClick={() => window.location.assign('/')}
      className="cursor-pointer flex h-[52px] w-[260px] items-center justify-start overflow-hidden"
      aria-label="Go to AnimaCut home"
    >
      <Image
        src="/brand/animacut-wordmark.png"
        alt="AnimaCut"
        width={520}
        height={140}
        className="ml-[-6px] h-[120px] w-auto max-w-none object-contain"
        priority
      />
    </button>
  );
}
