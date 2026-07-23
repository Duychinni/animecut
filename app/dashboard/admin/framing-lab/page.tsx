import { redirect } from 'next/navigation';
import { requireAdmin } from '@/lib/admin-auth';
import { FramingLab } from '@/components/admin/FramingLab';

export const dynamic = 'force-dynamic';

export default async function FramingLabPage() {
  if (!await requireAdmin()) redirect('/dashboard');
  return <FramingLab />;
}
