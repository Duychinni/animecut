'use client';

export function HomeLogoLink() {
  return (
    <button
      type="button"
      onClick={() => window.location.assign('/')}
      className="cursor-pointer flex items-center gap-3 text-white"
      aria-label="Go to AnimaCut home"
    >
      <span className="relative inline-flex h-9 w-9 items-center justify-center">
        <svg viewBox="0 0 48 48" className="h-9 w-9 overflow-visible" aria-hidden="true">
          <defs>
            <linearGradient id="animacutStroke" x1="8%" y1="10%" x2="92%" y2="88%">
              <stop offset="0%" stopColor="#b56cff" />
              <stop offset="45%" stopColor="#ff4fd8" />
              <stop offset="78%" stopColor="#ff7a59" />
              <stop offset="100%" stopColor="#ffbe3b" />
            </linearGradient>
            <filter id="animacutGlow" x="-80%" y="-80%" width="260%" height="260%">
              <feGaussianBlur stdDeviation="2.4" result="blur" />
              <feMerge>
                <feMergeNode in="blur" />
                <feMergeNode in="SourceGraphic" />
              </feMerge>
            </filter>
          </defs>
          <path
            d="M14 8 C11 8, 9 10.5, 9 14 V34 C9 38.5, 11.5 40, 14.5 37.4 L35.5 19.8 C39 16.9, 38.2 13.4, 34.8 11.8 L20.5 5.6 C17.4 4.3, 14 6.2, 14 8Z"
            fill="none"
            stroke="url(#animacutStroke)"
            strokeWidth="3.6"
            strokeLinecap="round"
            strokeLinejoin="round"
            filter="url(#animacutGlow)"
          />
          <path
            d="M12 33.5 L26.2 28.4 L35.8 20.3"
            fill="none"
            stroke="url(#animacutStroke)"
            strokeWidth="3.6"
            strokeLinecap="round"
            strokeLinejoin="round"
            filter="url(#animacutGlow)"
          />
        </svg>
      </span>

      <span className="select-none text-[1.55rem] font-black leading-none tracking-[-0.045em]">
        <span className="text-white">Anima</span>
        <span className="bg-[linear-gradient(135deg,#ff55c8_0%,#ff7b8b_55%,#ffbc42_100%)] bg-clip-text text-transparent">Cut</span>
      </span>
    </button>
  );
}
