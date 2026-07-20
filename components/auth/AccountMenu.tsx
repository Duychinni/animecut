'use client';

import Image from 'next/image';
import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import { SignOutButton } from '@/components/auth/SignOutButton';

type AccountMenuProps = {
  displayName: string;
  avatarUrl?: string | null;
};

export function AccountMenu({ displayName, avatarUrl }: AccountMenuProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [isHovered, setIsHovered] = useState(false);
  const [isPinnedOpen, setIsPinnedOpen] = useState(false);
  const isOpen = isHovered || isPinnedOpen;

  useEffect(() => {
    function closeFromOutside(event: MouseEvent | TouchEvent) {
      if (!containerRef.current?.contains(event.target as Node)) {
        setIsPinnedOpen(false);
        setIsHovered(false);
      }
    }

    function closeFromEscape(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        setIsPinnedOpen(false);
        setIsHovered(false);
      }
    }

    document.addEventListener('mousedown', closeFromOutside);
    document.addEventListener('touchstart', closeFromOutside);
    document.addEventListener('keydown', closeFromEscape);
    return () => {
      document.removeEventListener('mousedown', closeFromOutside);
      document.removeEventListener('touchstart', closeFromOutside);
      document.removeEventListener('keydown', closeFromEscape);
    };
  }, []);

  return (
    <div
      ref={containerRef}
      className="relative shrink-0"
      aria-label="Account"
      onMouseEnter={() => setIsHovered(true)}
      onMouseLeave={() => setIsHovered(false)}
    >
      <button
        type="button"
        className="flex items-center gap-2 rounded-full p-0.5 outline-none ring-white/30 focus-visible:ring-2"
        aria-haspopup="menu"
        aria-expanded={isOpen}
        onClick={() => setIsPinnedOpen((open) => !open)}
      >
        {avatarUrl ? (
          <Image src={avatarUrl} alt="Account avatar" width={32} height={32} className="h-8 w-8 rounded-full border border-white/20 object-cover" />
        ) : (
          <span aria-hidden="true" className="grid h-8 w-8 place-items-center rounded-full border border-white/20 bg-white/10 text-xs font-semibold text-white/85">
            {displayName.charAt(0).toUpperCase()}
          </span>
        )}
        <span className="hidden max-w-24 truncate text-xs font-semibold text-white/80 2xl:block">{displayName}</span>
      </button>

      <div
        className={`absolute right-0 top-full z-50 w-44 pt-2 transition ${isOpen ? 'visible translate-y-0 opacity-100' : 'invisible translate-y-1 opacity-0'}`}
      >
        <div role="menu" className="rounded-xl border border-white/15 bg-[#111018] p-2 shadow-2xl">
          <p className="truncate px-2 py-1.5 text-xs font-semibold text-white/60">{displayName}</p>
          <Link href="/dashboard/account" role="menuitem" className="block rounded-lg px-2 py-2 text-sm font-semibold text-white transition hover:bg-white/10">Account & privacy</Link>
          <SignOutButton className="w-full rounded-lg px-2 py-2 text-left text-sm font-semibold text-white transition hover:bg-white/10 disabled:opacity-60" />
        </div>
      </div>
    </div>
  );
}
