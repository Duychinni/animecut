import { NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';

export async function GET() {
  const commitSha = process.env.VERCEL_GIT_COMMIT_SHA
    || process.env.GIT_COMMIT_SHA
    || null;

  return NextResponse.json({
    ok: true,
    commit_sha: commitSha,
    deployment_environment: process.env.VERCEL_ENV || process.env.NODE_ENV || 'unknown',
    runtime: process.env.VERCEL ? 'vercel' : 'node',
  }, {
    headers: {
      'Cache-Control': 'no-store',
    },
  });
}
