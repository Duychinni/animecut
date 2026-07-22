'use client';

import Image from 'next/image';

export function HomeLogoLink() {
  return (
    <button
      type="button"
      onClick={() => window.location.assign('/')}
      className="flex h-[44px] w-[148px] cursor-pointer items-center justify-start overflow-hidden sm:h-[52px] sm:w-[260px]"
      aria-label="Go to AnimaCut home"
    >
      <Image
        src="/brand/animacut-wordmark.png"
        alt="AnimaCut"
        width={520}
        height={140}
        className="ml-[-4px] h-[78px] w-auto max-w-none object-contain sm:ml-[-6px] sm:h-[120px]"
        priority
      />
    </button>
  );
}
