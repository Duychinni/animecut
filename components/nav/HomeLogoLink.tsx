'use client';

import Image from 'next/image';

export function HomeLogoLink() {
  return (
    <button
      type="button"
      onClick={() => window.location.assign('/')}
      className="flex h-[42px] w-[124px] shrink-0 cursor-pointer items-center justify-start overflow-hidden min-[390px]:w-[136px] sm:h-[52px] sm:w-[260px]"
      aria-label="Go to AnimaCut home"
    >
      <Image
        src="/brand/animacut-wordmark.png"
        alt="AnimaCut"
        width={520}
        height={140}
        className="ml-[-4px] h-[68px] w-auto max-w-none object-contain min-[390px]:h-[74px] sm:ml-[-6px] sm:h-[120px]"
        priority
      />
    </button>
  );
}
