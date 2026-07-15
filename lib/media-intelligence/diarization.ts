import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createAdminClient } from '@/lib/supabase/admin';
import { resolveProjectVideoSource } from '@/lib/source';
import {
  DIARIZATION_SCHEMA_VERSION,
  diarizationArtifactSchema,
  type DiarizationArtifact,
} from '@/lib/media-intelligence/schema';
import {
  makeSpeakerEmbeddingObjectPath,
  removeAnalysisArtifactPath,
  uploadEncryptedSpeakerEmbeddings,
} from '@/lib/media-intelligence/storage';

const DEFAULT_MODEL = 'pyannote/speaker-diarization-community-1';
const DEFAULT_EMBEDDING_MODEL = 'pyannote/wespeaker-voxceleb-resnet34-LM';
const MAX_CAPTURE_BYTES = 256 * 1024;

type ProjectSource = {
  id: string;
  user_id: string;
  source_type: 'youtube' | 'upload';
  source_url?: string | null;
  source_storage_path?: string | null;
};

type DiarizationResult = {
  enabled: boolean;
  reused: boolean;
  mode: 'disabled' | 'full' | 'degraded' | 'safe';
  analysisRunId: string | null;
  speakerCount: number;
  turnCount: number;
  errorCategory?: string;
};

function envTrue(name: string) {
  return ['1', 'true', 'yes', 'on'].includes((process.env[name] || '').trim().toLowerCase());
}

export function isDiarizationEnabled(projectId: string) {
  if (!envTrue('DIARIZATION_ENABLED')) return false;
  if (envTrue('DIARIZATION_ALLOW_ALL')) return true;
  const allowlist = (process.env.DIARIZATION_PROJECT_ALLOWLIST || '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
  return allowlist.includes(projectId);
}

function getConfig() {
  const model = process.env.DIARIZATION_MODEL?.trim() || DEFAULT_MODEL;
  const modelRevision = process.env.DIARIZATION_MODEL_REVISION?.trim() || 'main';
  const embeddingModel = process.env.DIARIZATION_EMBEDDING_MODEL?.trim() || DEFAULT_EMBEDDING_MODEL;
  const embeddingModelRevision = process.env.DIARIZATION_EMBEDDING_MODEL_REVISION?.trim() || 'main';
  const timeoutSec = Math.max(60, Number(process.env.DIARIZATION_TIMEOUT_SEC || 3600));
  const extractTimeoutSec = Math.max(30, Number(process.env.DIARIZATION_EXTRACT_TIMEOUT_SEC || 300));
  const retentionDays = Math.max(1, Number(process.env.SPEAKER_EMBEDDING_RETENTION_DAYS || 3));
  return {
    provider: 'pyannote' as const,
    model,
    modelRevision,
    embeddingModel,
    embeddingModelRevision,
    timeoutSec,
    extractTimeoutSec,
    retentionDays,
    device: process.env.DIARIZATION_DEVICE?.trim() || 'cpu',
    python: process.env.DIARIZATION_PYTHON?.trim()
      || process.env.SMART_REFRAME_PYTHON?.trim()
      || (process.platform === 'win32' ? 'python' : 'python3'),
    script: process.env.DIARIZATION_SCRIPT?.trim()
      || path.join(process.cwd(), 'scripts', 'diarize_source.py'),
    ffmpeg: process.env.FFMPEG_PATH?.trim() || 'ffmpeg',
  };
}

function appendBounded(current: string, chunk: Buffer | string) {
  const next = current + chunk.toString();
  return next.length <= MAX_CAPTURE_BYTES ? next : next.slice(next.length - MAX_CAPTURE_BYTES);
}

async function sha256File(filePath: string) {
  const hash = createHash('sha256');
  await new Promise<void>((resolve, reject) => {
    const stream = createReadStream(filePath);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('error', reject);
    stream.on('end', resolve);
  });
  return hash.digest('hex');
}

function sanitizeError(message: string) {
  return message
    .replace(/hf_[A-Za-z0-9]+/g, '[redacted-token]')
    .split(/\r?\n/)
    .slice(-40)
    .join('\n')
    .slice(-8000);
}

function classifyError(message: string) {
  const lower = message.toLowerCase();
  if (/timed out|timeout/.test(lower)) return 'timeout';
  if (/out of memory|cannot allocate|cuda.*memory/.test(lower)) return 'resource_exhausted';
  if (/hf_token|unauthorized|gated|accept.*condition|401|403/.test(lower)) return 'model_access';
  if (/import failed|no module named|dependency/.test(lower)) return 'dependency_configuration';
  if (/no speech turns/.test(lower)) return 'no_speech';
  return 'diarization_failed';
}

async function runDiarizationScript(args: {
  sourcePath: string;
  embeddingPath: string;
  config: ReturnType<typeof getConfig>;
}) {
  const commandArgs = [
    args.config.script,
    '--input', args.sourcePath,
    '--embedding-output', args.embeddingPath,
    '--model', args.config.model,
    '--model-revision', args.config.modelRevision,
    '--embedding-model', args.config.embeddingModel,
    '--embedding-model-revision', args.config.embeddingModelRevision,
    '--device', args.config.device,
    '--ffmpeg', args.config.ffmpeg,
    '--extract-timeout-sec', String(args.config.extractTimeoutSec),
  ];

  const result = await new Promise<{ code: number | null; stdout: string; stderr: string; timedOut: boolean }>((resolve, reject) => {
    const proc = spawn(args.config.python, commandArgs, {
      cwd: process.cwd(),
      env: process.env,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let settled = false;
    let timedOut = false;
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (forceKill) clearTimeout(forceKill);
      callback();
    };
    let forceKill: NodeJS.Timeout | null = null;
    const timeout = setTimeout(() => {
      timedOut = true;
      proc.kill('SIGTERM');
      forceKill = setTimeout(() => proc.kill('SIGKILL'), 10_000);
      forceKill.unref();
    }, args.config.timeoutSec * 1000);
    timeout.unref();

    proc.stdout.on('data', (chunk) => { stdout = appendBounded(stdout, chunk); });
    proc.stderr.on('data', (chunk) => { stderr = appendBounded(stderr, chunk); });
    proc.on('error', (error) => finish(() => reject(error)));
    proc.on('close', (code) => finish(() => resolve({ code, stdout, stderr, timedOut })));
  });

  if (result.timedOut) {
    throw new Error(`Diarization timed out after ${args.config.timeoutSec} seconds`);
  }

  let raw: unknown;
  try {
    raw = JSON.parse(result.stdout.trim() || '{}');
  } catch {
    throw new Error(`Diarization returned invalid JSON: ${sanitizeError(result.stderr || result.stdout)}`);
  }
  const scriptError = raw && typeof raw === 'object' && 'error' in raw ? String(raw.error || '') : '';
  if (result.code !== 0 || scriptError) {
    throw new Error(sanitizeError(scriptError || result.stderr || `Diarization exited with code ${result.code}`));
  }
  return diarizationArtifactSchema.parse(raw);
}

function retentionExpiry(days: number) {
  return new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString();
}

async function findReusableRun(projectId: string, sourceSha256: string, config: ReturnType<typeof getConfig>) {
  const admin = createAdminClient();
  const { data, error } = await admin
    .from('media_analysis_runs')
    .select('id, operating_mode, status, speaker_count, turn_count')
    .eq('project_id', projectId)
    .eq('source_sha256', sourceSha256)
    .eq('schema_version', DIARIZATION_SCHEMA_VERSION)
    .eq('diarization_provider', config.provider)
    .eq('diarization_model', config.model)
    .eq('diarization_model_revision', config.modelRevision)
    .eq('embedding_model', config.embeddingModel)
    .eq('embedding_model_revision', config.embeddingModelRevision)
    .in('status', ['done', 'degraded'])
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  return data;
}

async function createAnalysisRun(projectId: string, sourceSha256: string, config: ReturnType<typeof getConfig>) {
  const admin = createAdminClient();
  const workerCommit = process.env.VERCEL_GIT_COMMIT_SHA || process.env.GIT_COMMIT_SHA || 'unknown';
  const { data, error } = await admin
    .from('media_analysis_runs')
    .insert({
      project_id: projectId,
      source_sha256: sourceSha256,
      operating_mode: 'full',
      schema_version: DIARIZATION_SCHEMA_VERSION,
      diarization_provider: config.provider,
      diarization_model: config.model,
      diarization_model_revision: config.modelRevision,
      embedding_model: config.embeddingModel,
      embedding_model_revision: config.embeddingModelRevision,
      status: 'processing',
      device: config.device,
      worker_commit_sha: workerCommit,
      started_at: new Date().toISOString(),
      attempt_count: 1,
    })
    .select('id')
    .single();
  if (!error && data?.id) return { id: String(data.id), claimed: true as const };
  if (error && (error as { code?: string }).code !== '23505') throw error;

  const { data: existing, error: existingError } = await admin
    .from('media_analysis_runs')
    .select('id, status, operating_mode, speaker_count, turn_count')
    .eq('project_id', projectId)
    .eq('source_sha256', sourceSha256)
    .eq('schema_version', DIARIZATION_SCHEMA_VERSION)
    .eq('diarization_provider', config.provider)
    .eq('diarization_model', config.model)
    .eq('diarization_model_revision', config.modelRevision)
    .eq('embedding_model', config.embeddingModel)
    .eq('embedding_model_revision', config.embeddingModelRevision)
    .single();
  if (existingError || !existing) throw existingError || new Error('Failed to resolve concurrent diarization run');
  return { id: String(existing.id), claimed: false as const, existing };
}

async function persistFullResult(args: {
  project: ProjectSource;
  analysisRunId: string;
  sourceSha256: string;
  artifact: DiarizationArtifact;
  embeddingBytes: Buffer;
  config: ReturnType<typeof getConfig>;
}) {
  const admin = createAdminClient();
  const objectPath = makeSpeakerEmbeddingObjectPath(args.project.user_id, args.project.id, args.analysisRunId);
  const expiresAt = retentionExpiry(args.config.retentionDays);
  await uploadEncryptedSpeakerEmbeddings(objectPath, args.embeddingBytes);
  try {
    const speakerRows = args.artifact.speakers.map((speaker) => ({
      analysis_run_id: args.analysisRunId,
      project_id: args.project.id,
      speaker_key: speaker.speaker_key,
      evidence_duration_sec: speaker.evidence_duration_sec,
      embedding_model: args.artifact.embedding_model,
      embedding_model_revision: args.artifact.embedding_model_revision,
      embedding_dimension: speaker.embedding_dimension,
    }));
    const { data: savedSpeakers, error: speakerError } = await admin
      .from('source_speakers')
      .insert(speakerRows)
      .select('id, speaker_key');
    if (speakerError) throw speakerError;
    const speakerIds = new Map((savedSpeakers ?? []).map((speaker) => [String(speaker.speaker_key), String(speaker.id)]));

    const { error: turnError } = await admin.from('speaker_turns').insert(args.artifact.turns.map((turn) => ({
      analysis_run_id: args.analysisRunId,
      project_id: args.project.id,
      speaker_id: turn.speaker_key ? speakerIds.get(turn.speaker_key) ?? null : null,
      speaker_key: turn.speaker_key,
      start_sec: turn.start_sec,
      end_sec: turn.end_sec,
      confidence: turn.confidence,
      confidence_source: turn.confidence_source,
      overlap: turn.overlap,
      classification: turn.classification,
    })));
    if (turnError) throw turnError;

    const { error: artifactError } = await admin.from('speaker_embedding_artifacts').insert({
      analysis_run_id: args.analysisRunId,
      project_id: args.project.id,
      storage_path: objectPath,
      encryption_algorithm: 'aes-256-gcm',
      encryption_key_version: process.env.ANALYSIS_ARTIFACT_ENCRYPTION_KEY_VERSION?.trim() || 'v1',
      expires_at: expiresAt,
    });
    if (artifactError) throw artifactError;

    const { error: runError } = await admin.from('media_analysis_runs').update({
      status: 'done',
      operating_mode: 'full',
      provider_version: args.artifact.provider_version,
      embedding_model: args.artifact.embedding_model,
      embedding_model_revision: args.artifact.embedding_model_revision,
      speaker_count: args.artifact.speakers.length,
      turn_count: args.artifact.turns.length,
      duration_sec: args.artifact.duration_sec,
      diagnostics: args.artifact.diagnostics,
      completed_at: new Date().toISOString(),
      error_category: null,
      error_detail: null,
    }).eq('id', args.analysisRunId);
    if (runError) throw runError;
  } catch (error) {
    await removeAnalysisArtifactPath(objectPath).catch(() => undefined);
    throw error;
  }
}

async function persistDegradedResult(analysisRunId: string, error: unknown) {
  const admin = createAdminClient();
  const message = sanitizeError(error instanceof Error ? error.message : String(error));
  const category = classifyError(message);
  const requestedMode = (process.env.DIARIZATION_FAILURE_MODE || 'degraded').trim().toLowerCase();
  const mode = requestedMode === 'safe' ? 'safe' : 'degraded';
  const { error: updateError } = await admin.from('media_analysis_runs').update({
    status: 'degraded',
    operating_mode: mode,
    error_category: category,
    error_detail: message,
    completed_at: new Date().toISOString(),
  }).eq('id', analysisRunId);
  if (updateError) throw updateError;
  return { mode: mode as 'degraded' | 'safe', category };
}

export async function ensureSourceDiarization(projectId: string): Promise<DiarizationResult> {
  if (!isDiarizationEnabled(projectId)) {
    return { enabled: false, reused: false, mode: 'disabled', analysisRunId: null, speakerCount: 0, turnCount: 0 };
  }

  const config = getConfig();
  const admin = createAdminClient();
  const { data: project, error: projectError } = await admin
    .from('projects')
    .select('id, user_id, source_type, source_url, source_storage_path')
    .eq('id', projectId)
    .single();
  if (projectError || !project) throw projectError || new Error('Project not found for diarization');

  const typedProject = project as ProjectSource;
  const sourcePath = await resolveProjectVideoSource(typedProject);
  const sourceSha256 = await sha256File(sourcePath);
  const reusable = await findReusableRun(projectId, sourceSha256, config);
  if (reusable) {
    return {
      enabled: true,
      reused: true,
      mode: reusable.operating_mode === 'safe' ? 'safe' : reusable.operating_mode === 'full' ? 'full' : 'degraded',
      analysisRunId: String(reusable.id),
      speakerCount: Number(reusable.speaker_count ?? 0),
      turnCount: Number(reusable.turn_count ?? 0),
    };
  }

  const claim = await createAnalysisRun(projectId, sourceSha256, config);
  const analysisRunId = claim.id;
  if (!claim.claimed) {
    return {
      enabled: true,
      reused: true,
      mode: claim.existing?.operating_mode === 'safe'
        ? 'safe'
        : claim.existing?.operating_mode === 'full' && claim.existing?.status === 'done'
          ? 'full'
          : 'degraded',
      analysisRunId,
      speakerCount: Number(claim.existing?.speaker_count ?? 0),
      turnCount: Number(claim.existing?.turn_count ?? 0),
    };
  }
  const workDir = path.join(process.cwd(), 'tmp', 'media-intelligence', projectId, `${analysisRunId}-${randomUUID()}`);
  const embeddingPath = path.join(workDir, 'speaker-embeddings.npz');
  await mkdir(workDir, { recursive: true });
  try {
    const artifact = await runDiarizationScript({ sourcePath, embeddingPath, config });
    if (path.resolve(artifact.embedding_file) !== path.resolve(embeddingPath)) {
      throw new Error('Diarization returned an unexpected embedding artifact path');
    }
    const embeddingBytes = await readFile(embeddingPath);
    try {
      await persistFullResult({
        project: typedProject,
        analysisRunId,
        sourceSha256,
        artifact,
        embeddingBytes,
        config,
      });
    } finally {
      embeddingBytes.fill(0);
    }
    return {
      enabled: true,
      reused: false,
      mode: 'full',
      analysisRunId,
      speakerCount: artifact.speakers.length,
      turnCount: artifact.turns.length,
    };
  } catch (error) {
    const degraded = await persistDegradedResult(analysisRunId, error);
    if ((process.env.DIARIZATION_FAILURE_MODE || 'degraded').trim().toLowerCase() === 'fail') throw error;
    return {
      enabled: true,
      reused: false,
      mode: degraded.mode,
      analysisRunId,
      speakerCount: 0,
      turnCount: 0,
      errorCategory: degraded.category,
    };
  } finally {
    await rm(workDir, { recursive: true, force: true }).catch(() => undefined);
  }
}
