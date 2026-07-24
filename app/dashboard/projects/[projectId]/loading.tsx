export default function ProjectDetailLoading() {
  return (
    <main className="mx-auto w-full max-w-[2400px] px-8 py-10" aria-busy="true" aria-label="Opening project">
      <section className="flex flex-col items-center">
        <div className="mb-8 h-8 w-72 max-w-full animate-pulse rounded-lg bg-white/10" />
        <div className="grid w-full grid-cols-1 gap-5 sm:grid-cols-2 xl:grid-cols-3">
          {Array.from({ length: 6 }, (_, index) => (
            <div key={index} className="overflow-hidden rounded-2xl border border-white/10 bg-white/[0.03]">
              <div className="aspect-[9/16] max-h-[560px] animate-pulse bg-white/[0.06]" />
              <div className="space-y-3 p-4">
                <div className="h-5 w-3/4 animate-pulse rounded bg-white/10" />
                <div className="h-4 w-1/2 animate-pulse rounded bg-white/[0.07]" />
              </div>
            </div>
          ))}
        </div>
      </section>
    </main>
  );
}
