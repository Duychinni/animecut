'use client';

type DeleteProjectModalProps = {
  projectTitle?: string;
  deleting?: boolean;
  onCancel: () => void;
  onConfirm: () => void;
};

export function DeleteProjectModal({ projectTitle, deleting = false, onCancel, onConfirm }: DeleteProjectModalProps) {
  return (
    <div
      className="fixed inset-0 z-[100] grid place-items-center bg-black/75 px-4 backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
      aria-labelledby="delete-project-title"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !deleting) onCancel();
      }}
    >
      <div className="w-full max-w-[430px] overflow-hidden rounded-2xl border border-white/10 bg-[#0d0b12] shadow-[0_24px_90px_rgba(0,0,0,0.65)]">
        <div className="h-1 bg-gradient-to-r from-[#8b5cf6] via-[#d946ef] to-[#f59e0b]" />
        <div className="p-6 sm:p-7">
          <div className="mb-5 grid h-11 w-11 place-items-center rounded-xl border border-fuchsia-400/20 bg-fuchsia-400/10 text-fuchsia-200">
            <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M3 6h18" /><path d="M8 6V4h8v2" /><path d="M19 6l-1 14H6L5 6" /><path d="M10 11v5M14 11v5" />
            </svg>
          </div>
          <h3 id="delete-project-title" className="text-xl font-black tracking-tight text-white">Delete this project?</h3>
          <p className="mt-2 text-sm leading-6 text-white/60">
            {projectTitle ? <><span className="font-semibold text-white/80">{projectTitle}</span> and all its clips, exports, and source files will be permanently removed.</> : 'Its clips, exports, and source files will be permanently removed.'}
          </p>
          <div className="mt-7 flex items-center justify-end gap-3">
            <button type="button" onClick={onCancel} disabled={deleting} className="rounded-lg border border-white/12 px-4 py-2.5 text-sm font-bold text-white/70 transition hover:border-white/25 hover:bg-white/[0.06] hover:text-white disabled:opacity-50">Cancel</button>
            <button type="button" onClick={onConfirm} disabled={deleting} className="rounded-lg bg-white px-4 py-2.5 text-sm font-black text-black transition hover:bg-white/85 disabled:cursor-wait disabled:opacity-60">
              {deleting ? 'Deleting…' : 'Delete project'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
