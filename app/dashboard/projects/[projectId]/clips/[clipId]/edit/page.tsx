import { ClipEditor } from '@/components/editor/ClipEditor';

export default async function ClipEditPage({
  params,
}: {
  params: Promise<{ projectId: string; clipId: string }>;
}) {
  const { projectId, clipId } = await params;
  return <ClipEditor projectId={projectId} clipId={clipId} />;
}
