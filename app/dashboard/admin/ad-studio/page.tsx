import { redirect } from 'next/navigation';
import { requireAdmin } from '@/lib/admin-auth';
import { AdStudio } from '@/components/admin/AdStudio';

export const dynamic = 'force-dynamic';

export default async function AdStudioPage() {
  if (!await requireAdmin()) redirect('/dashboard');
  return <AdStudio />;
}
