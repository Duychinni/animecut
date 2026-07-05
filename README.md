# ClipSpark v0 (MVP scaffold)

Lean MVP for podcast/talking-head clipping.

## Stack
- Next.js (app router)
- Supabase (auth, postgres, storage)
- OpenAI (transcription + clip candidate analysis)
- FFmpeg (9:16 clip export)

## Implemented in v0
- Auth flow (Supabase email+password)
  - `/auth/login`
  - `/auth/signup`
  - `/auth/callback`
  - middleware-protected dashboard routes
- Project creation UI and API
- Source options:
  - YouTube URL
  - Local upload file
- Project detail page with:
  - `Run AI Pipeline` button
  - `Export Top 3 Clips` button
  - candidate list + recent export list
- End-to-end pipeline:
  1. create project
  2. transcribe via OpenAI Whisper
  3. analyze transcript for top clip candidates + scores
  4. queue export jobs
  5. process jobs into 9:16 clips with basic burned captions
- Supabase migration SQL for schema + RLS

## Current constraints (intentional for MVP)
- Job rendering still uses temporary local files in `tmp/ingest` and `tmp/exports` before upload
- Heavy export jobs may time out on low-tier serverless plans; recurring cron/worker processing is configured, but long-running media workloads still need a deployment/runtime that can actually execute ffmpeg and yt-dlp reliably.

## Environment
Copy `.env.example` to `.env.local` and set:
- `NEXT_PUBLIC_SUPABASE_URL`
- `NEXT_PUBLIC_SUPABASE_ANON_KEY`
- `SUPABASE_SERVICE_ROLE_KEY`
- `OPENAI_API_KEY`
- `APP_URL` (e.g. `http://localhost:3000` locally)
- `CRON_SECRET` (shared secret for cron endpoint auth)

Update Supabase Auth settings:
- Site URL: your app URL (`http://localhost:3000` for local)
- Redirect URL allowlist includes: `<APP_URL>/auth/callback`

## Quick start
1. `cp .env.example .env.local`
2. Fill env vars
3. Ensure `yt-dlp` and `ffmpeg` are installed on host
4. `npm run dev`
5. Run Supabase migrations in your Supabase SQL editor (or CLI):
   - `supabase/migrations/0001_init.sql`
   - `supabase/migrations/0002_indexes_rls.sql`
   - `supabase/migrations/0003_storage.sql`
   - `supabase/migrations/0004_project_source_metadata.sql`
   - `supabase/migrations/0005_project_pipeline_state.sql`

## Main routes
- UI
  - `/`
  - `/auth/login`
  - `/auth/signup`
  - `/dashboard`
  - `/dashboard/projects`
  - `/dashboard/projects/:projectId`
- API
  - `POST /api/projects`
  - `POST /api/ingest/upload` (multipart form: `project_id`, `file`)
  - `POST /api/transcribe` (`{ project_id }`)
  - `POST /api/analyze` (`{ project_id }`)
  - `POST /api/clips/preview` (`{ project_id }`)
  - `POST /api/clips/export` (`{ project_id, candidate_ids }`)
  - `POST /api/jobs/process`
  - `POST /api/projects/:projectId/start`
  - `POST /api/pipeline/process`
  - `GET /api/cron/process-jobs` (Bearer `CRON_SECRET`)

## Deploy (Vercel)
1. Push repo to GitHub
2. Import project into Vercel
3. Add all env vars from above
4. Deploy
5. Confirm `vercel.json` cron is active for `/api/cron/process-jobs`
6. Update Supabase Auth Site URL + redirect URL to your production domain

### Background processing note
The app now uses durable project pipeline jobs.
That means reopening an unfinished project should reattach to its processing state instead of restarting from zero.
For that to continue while the user is away, your deployment must keep invoking `/api/cron/process-jobs` on schedule and must be able to execute the media pipeline (`ffmpeg`, `yt-dlp`, transcription, export processing).

## Next coding steps
- Move media in/out of Supabase Storage (signed URLs)
- Trigger jobs processor via cron/background worker
- Add in-app clip playback preview with seekable ranges
- Improve caption styling and active-speaker reframing
