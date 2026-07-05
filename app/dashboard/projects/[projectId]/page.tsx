import { createClient } from '@/lib/supabase/server';
import { PipelineRunner } from '@/components/project/PipelineRunner';
import { ProjectQuickStart } from '@/components/project/ProjectQuickStart';
import { TopClipsBoard } from '@/components/clips/TopClipsBoard';
import { createExportSignedUrl } from '@/lib/storage';

type ExportRow = {
  id: string;
  clip_candidate_id: string | null;
  status: string;
  output_storage_path: string | null;
  error_message: string | null;
  created_at: string;
};

type CandidateRow = {
  id: string;
  title: string;
  overall_score: number;
  start_sec: number;
  end_sec: number;
  reason: string;
  hook_strength: number;
  rank: number | null;
};

export default async function ProjectDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ projectId: string }>;
  searchParams: Promise<{ autorun?: string }>;
}) {
  const { projectId } = await params;
  const { autorun } = await searchParams;
  const autoStart = autorun === '1' || autorun === 'true';
  const supabase = await createClient();

  const [{ data: exportsRows }, { data: candidateRows }] = await Promise.all([
    supabase
      .from('exports')
      .select('id, clip_candidate_id, status, output_storage_path, error_message, created_at')
      .eq('project_id', projectId)
      .order('created_at', { ascending: false })
      .limit(10),
    supabase
      .from('clip_candidates')
      .select('id, title, overall_score, start_sec, end_sec, reason, hook_strength, rank')
      .eq('project_id', projectId)
      .limit(50),
  ]);

  const candidatesById = new Map<string, CandidateRow>(
    ((candidateRows ?? []) as CandidateRow[]).map((c) => [String(c.id), c]),
  );

  const exportItems = await Promise.all(
    ((exportsRows ?? []) as ExportRow[]).map(async (row) => {
      let signedUrl: string | null = null;
      if (row.output_storage_path && !row.output_storage_path.startsWith('/')) {
        try {
          signedUrl = await createExportSignedUrl(row.output_storage_path, 60 * 60);
        } catch {
          signedUrl = null;
        }
      }

      const candidate = row.clip_candidate_id ? candidatesById.get(String(row.clip_candidate_id)) : undefined;

      return {
        ...row,
        signedUrl,
        title: candidate?.title ?? 'Untitled clip',
        score: Number(candidate?.overall_score ?? 0),
        startSec: candidate ? Number(candidate.start_sec) : null,
        endSec: candidate ? Number(candidate.end_sec) : null,
        reason: candidate?.reason ?? null,
        hookStrength: candidate ? Number(candidate.hook_strength) : null,
        rank: candidate?.rank ?? null,
      };
    }),
  );

  return (
    <main className="mx-auto w-full max-w-[2400px] space-y-6 px-8 py-10">
      <section className="rounded-2xl border border-white/10 bg-white/[0.03] p-6">
        <ProjectQuickStart />

        <div className="mt-5 flex flex-wrap gap-3">
          <PipelineRunner projectId={projectId} autoStart={autoStart} />
        </div>

        {exportItems.length ? (
          <TopClipsBoard
            projectId={projectId}
            clips={exportItems.map((row) => ({
              exportId: row.id,
              clipCandidateId: row.clip_candidate_id,
              title: row.title,
              score: row.score,
              status: row.status,
              errorMessage: row.error_message,
              signedUrl: row.signedUrl,
              startSec: row.startSec,
              endSec: row.endSec,
              rank: row.rank,
            }))}
          />
        ) : null}
      </section>

    </main>
  );
}
