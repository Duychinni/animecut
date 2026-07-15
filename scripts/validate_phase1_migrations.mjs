import { readFile } from 'node:fs/promises';
import path from 'node:path';

const root = process.cwd();
const files = [
  'supabase/migrations/0014_schema_reconciliation.sql',
  'supabase/migrations/0015_source_diarization.sql',
];

const required = new Map([
  [files[0], ['create table if not exists public.profiles', 'create table if not exists public.usage_ledger', "'completed'"]],
  [files[1], [
    'create table if not exists public.media_analysis_runs',
    'create table if not exists public.source_speakers',
    'create table if not exists public.speaker_turns',
    'create table if not exists public.speaker_embedding_artifacts',
    "values ('analysis-artifacts', 'analysis-artifacts', false)",
    'alter table public.speaker_embedding_artifacts enable row level security',
    'on delete cascade',
    'embedding_model_revision',
    'intentionally no authenticated-client policy for speaker_embedding_artifacts',
  ]],
]);

for (const relative of files) {
  const sql = (await readFile(path.join(root, relative), 'utf8')).toLowerCase();
  for (const fragment of required.get(relative) ?? []) {
    if (!sql.includes(fragment.toLowerCase())) {
      throw new Error(`${relative} is missing required fragment: ${fragment}`);
    }
  }
  for (const forbidden of ['drop table', 'truncate table', 'delete from public.projects', 'delete from public.exports']) {
    if (sql.includes(forbidden)) throw new Error(`${relative} contains destructive statement: ${forbidden}`);
  }
}

const diarizationSql = (await readFile(path.join(root, files[1]), 'utf8')).toLowerCase();
if (/create\s+policy[\s\S]{0,200}\bon\s+public\.speaker_embedding_artifacts\b/.test(diarizationSql)) {
  throw new Error('speaker_embedding_artifacts must not have a browser/authenticated-client policy');
}
const uniqueRunKey = diarizationSql.match(
  /create unique index if not exists media_analysis_runs_source_version_idx[\s\S]*?\);/,
)?.[0] ?? '';
for (const field of [
  'source_sha256',
  'schema_version',
  'diarization_model_revision',
  'embedding_model_revision',
]) {
  if (!uniqueRunKey.includes(field)) {
    throw new Error(`source-analysis idempotency key is missing ${field}`);
  }
}

console.log('Phase 1 migration static checks passed.');
