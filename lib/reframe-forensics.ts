import { createHash } from 'node:crypto';
import { appendFile, copyFile, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const FORENSIC_ROOT = path.resolve(process.cwd(), 'tmp', 'reframe-forensic');

export function reframeForensicsEnabled() {
  return process.env.SMART_REFRAME_FORENSIC?.trim().toLowerCase() === 'true';
}

export function forensicTargetMatches(candidateId?: string | null, clipId?: string | null) {
  if (!reframeForensicsEnabled()) return false;
  const target = process.env.SMART_REFRAME_DEBUG_CLIP_ID?.trim();
  if (!target) return false;
  return target === candidateId || target === clipId;
}

export function resolveForensicDir(candidateId?: string) {
  const requested = process.env.SMART_REFRAME_DEBUG_DIR?.trim();
  const resolved = path.resolve(requested || path.join(FORENSIC_ROOT, candidateId || 'unknown'));
  const relative = path.relative(FORENSIC_ROOT, resolved);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`Unsafe forensic directory outside ${FORENSIC_ROOT}`);
  }
  return resolved;
}

function redactString(value: string) {
  if (/^https?:\/\//i.test(value)) {
    try {
      const url = new URL(value);
      return `${url.origin}${url.pathname}`;
    } catch {
      return '[redacted-url]';
    }
  }
  return value;
}

export function sanitizeForensicValue(value: unknown, key = ''): unknown {
  if (/secret|token|password|authorization|cookie|service.?role|signed.?url/i.test(key)) return '[redacted]';
  if (typeof value === 'string') return redactString(value);
  if (Array.isArray(value)) return value.map((item) => sanitizeForensicValue(item, key));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([childKey, child]) => [
      childKey,
      sanitizeForensicValue(child, childKey),
    ]));
  }
  return value;
}

export async function writeForensicJson(name: string, value: unknown, candidateId?: string) {
  if (!forensicTargetMatches(candidateId)) return;
  const dir = resolveForensicDir(candidateId);
  await mkdir(dir, { recursive: true });
  const destination = path.join(dir, name);
  const temporary = `${destination}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(sanitizeForensicValue(value), null, 2)}\n`, 'utf8');
  await rename(temporary, destination);
}

export async function writeForensicText(name: string, value: string, candidateId?: string) {
  if (!forensicTargetMatches(candidateId)) return;
  const dir = resolveForensicDir(candidateId);
  await mkdir(dir, { recursive: true });
  const destination = path.join(dir, name);
  const temporary = `${destination}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temporary, value, 'utf8');
  await rename(temporary, destination);
}

export async function copyForensicFile(source: string, name: string, candidateId?: string) {
  if (!forensicTargetMatches(candidateId)) return;
  const dir = resolveForensicDir(candidateId);
  await mkdir(dir, { recursive: true });
  await copyFile(source, path.join(dir, name));
}

export async function appendForensicLog(event: Record<string, unknown>, candidateId?: string) {
  if (!forensicTargetMatches(candidateId)) return;
  const dir = resolveForensicDir(candidateId);
  await mkdir(dir, { recursive: true });
  await appendFile(
    path.join(dir, 'worker-log.jsonl'),
    `${JSON.stringify(sanitizeForensicValue({ timestamp: new Date().toISOString(), ...event }))}\n`,
    'utf8',
  );
}

export async function sha256File(filePath: string) {
  const data = await readFile(filePath);
  return createHash('sha256').update(data).digest('hex');
}

export async function removeForensicArtifact(filePath: string) {
  if (!reframeForensicsEnabled()) return false;
  const resolved = path.resolve(filePath);
  const repoRoot = path.resolve(process.cwd());
  const relative = path.relative(repoRoot, resolved);
  if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('Refusing to remove artifact outside repository');
  await rm(resolved, { force: true });
  return true;
}

export function currentGitSha() {
  const result = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: process.cwd(), encoding: 'utf8' });
  return result.status === 0 ? result.stdout.trim() : 'unknown';
}
