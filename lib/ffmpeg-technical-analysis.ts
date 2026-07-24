import { spawn } from 'node:child_process';
import ffmpegStatic from 'ffmpeg-static';
import type { ClipTechnicalMetrics } from '@/lib/clip-score';

function runFfmpeg(args: string[], timeoutMs = 120_000) {
  return new Promise<string>((resolve, reject) => {
    const child = spawn(process.env.FFMPEG_PATH || ffmpegStatic || 'ffmpeg', args, {
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error('FFmpeg technical analysis timed out'));
    }, timeoutMs);
    child.stderr.on('data', (chunk) => {
      stderr += String(chunk);
      if (stderr.length > 2_000_000) stderr = stderr.slice(-2_000_000);
    });
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(stderr);
      else reject(new Error(`FFmpeg technical analysis exited ${code}: ${stderr.slice(-1000)}`));
    });
  });
}

function totalIntervals(log: string, startPattern: RegExp, endPattern: RegExp, duration: number) {
  const starts = [...log.matchAll(startPattern)].map((match) => Number(match[1])).filter(Number.isFinite);
  const ends = [...log.matchAll(endPattern)].map((match) => Number(match[1])).filter(Number.isFinite);
  let total = 0;
  for (let index = 0; index < starts.length; index += 1) {
    const end = ends[index] ?? duration;
    total += Math.max(0, end - starts[index]);
  }
  return Math.max(0, Math.min(duration, total));
}

function lastNumber(log: string, pattern: RegExp) {
  const matches = [...log.matchAll(pattern)];
  const value = matches.length ? Number(matches[matches.length - 1][1]) : Number.NaN;
  return Number.isFinite(value) ? value : null;
}

export async function analyzeRenderedClipTechnicalQuality(
  inputPath: string,
  base: ClipTechnicalMetrics,
): Promise<{ metrics: ClipTechnicalMetrics; technicalQuality: number }> {
  const duration = Math.max(0.01, base.duration_seconds);
  let log: string;
  try {
    log = await runFfmpeg([
      '-hide_banner',
      '-nostats',
      '-i', inputPath,
      '-filter_complex',
      '[0:a]silencedetect=noise=-38dB:d=0.25,ebur128=peak=true[a];'
        + '[0:v]blackdetect=d=0.2:pix_th=0.10,freezedetect=n=-50dB:d=0.5,blurdetect=block_width=32:block_height=32,scdet=t=10[v]',
      '-map', '[a]',
      '-map', '[v]',
      '-f', 'null',
      '-',
    ]);
  } catch {
    // Videos without audio still receive visual technical analysis.
    log = await runFfmpeg([
      '-hide_banner',
      '-nostats',
      '-i', inputPath,
      '-vf', 'blackdetect=d=0.2:pix_th=0.10,freezedetect=n=-50dB:d=0.5,blurdetect=block_width=32:block_height=32,scdet=t=10',
      '-an',
      '-f', 'null',
      '-',
    ]);
  }

  const blackSeconds = totalIntervals(log, /black_start:([0-9.]+)/g, /black_end:([0-9.]+)/g, duration);
  const frozenSeconds = totalIntervals(log, /freeze_start:\s*([0-9.]+)/g, /freeze_end:\s*([0-9.]+)/g, duration);
  const integratedLoudness = lastNumber(log, /\bI:\s*(-?[0-9.]+)\s*LUFS/g);
  const truePeak = lastNumber(log, /\bPeak:\s*(-?[0-9.]+)\s*dBFS/g);
  const blurScore = lastNumber(log, /blur_mean:\s*([0-9.]+)/g);
  const sceneBoundaryTimestamps = [...log.matchAll(/lavfi\.scd\.time[=:]\s*([0-9.]+)/g)]
    .map((match) => Number(match[1]))
    .filter(Number.isFinite);
  const videoInfo = log.match(/Video:.*?(\d{2,5})x(\d{2,5}).*?(\d+(?:\.\d+)?)\s*fps/i);
  const blackRatio = blackSeconds / duration;
  const frozenRatio = frozenSeconds / duration;

  let technicalQuality = 100;
  if (integratedLoudness != null) {
    const loudnessDistance = Math.abs(integratedLoudness - (-16));
    technicalQuality -= Math.min(20, loudnessDistance * 1.4);
  }
  if (truePeak != null && truePeak > -0.5) technicalQuality -= 12;
  technicalQuality -= Math.min(35, blackRatio * 180);
  technicalQuality -= Math.min(35, frozenRatio * 180);
  if (blurScore != null && blurScore < 3) technicalQuality -= 12;

  return {
    metrics: {
      ...base,
      integrated_loudness: integratedLoudness,
      audio_peak_or_clipping_indicator: truePeak == null ? null : truePeak > -0.5,
      black_frame_ratio: Number(blackRatio.toFixed(4)),
      frozen_frame_ratio: Number(frozenRatio.toFixed(4)),
      blur_score: blurScore,
      scene_boundary_count: sceneBoundaryTimestamps.length,
      scene_boundary_timestamps: sceneBoundaryTimestamps,
      video_width: videoInfo ? Number(videoInfo[1]) : base.video_width,
      video_height: videoInfo ? Number(videoInfo[2]) : base.video_height,
      frame_rate: videoInfo ? Number(videoInfo[3]) : base.frame_rate,
    },
    technicalQuality: Math.max(0, Math.min(100, Math.round(technicalQuality))),
  };
}
